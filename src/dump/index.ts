import { createHash } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRedactor } from '../logger/redact.js'

export interface DumpLogger {
  debug(message: string, data?: unknown): void
  warn(message: string, data?: unknown): void
}

export interface DumpOptions {
  /** Directory dumps are written to; a function is read on every dump. */
  dir: string | (() => string)
  /** Initial state; `setEnabled` switches it at runtime. Default off. */
  enabled?: boolean
  /** Written into every filename. Default the current process id. */
  pid?: number
  /** Clock for filenames and `createdAt`. Default `Date.now`. */
  now?: () => number
  logger?: DumpLogger
  /**
   * Key names redacted wherever they appear in headers, request metadata and
   * the body, on top of the common credential set. Compared lower-cased with
   * `-` and `_` removed, so `ChatGPT-Account-Id` and `chatgptAccountId` match
   * `chatgptaccountid`.
   */
  secretKeys?: readonly string[]
  /** Value patterns scrubbed from every string, on top of the common token patterns. */
  secretPatterns?: readonly RegExp[]
  /**
   * Keys, at any depth of the body, whose values are declarations rather than
   * data: their strings are scrubbed but their key names are never redacted.
   * Default `['tools']`.
   */
  schemaKeys?: readonly string[]
  /**
   * Provider summary of the parsed body, stored in the metadata as `body`.
   * It receives the redacted body.
   */
  summarize?: (body: Record<string, unknown>) => Record<string, unknown>
}

export interface DumpInput {
  /** The session the request belongs to; missing means `session-unknown`. */
  session?: string | null
  /**
   * Diff baseline group: a dump is diffed against the previous dump of the
   * same session and channel (for example, one per transport).
   */
  channel: string
  /** Finer label for the filename, e.g. prewarm or main; it does not split the baseline. */
  phase?: string
  bodyText: string
  accountId?: string
  url?: string
  method?: string
  headers?: ConstructorParameters<typeof Headers>[0]
  status?: number
  error?: string
  /** Extra metadata, redacted like the body. */
  meta?: Record<string, unknown>
}

export interface DumpDiff {
  changed: boolean
  firstByte: number
  lastPreviousByte: number
  lastCurrentByte: number
  changedPreviousBytes?: number
  changedCurrentBytes?: number
  previousBytes: number
  currentBytes: number
}

export interface DumpResult {
  id: string
  files: { body: string; metadata: string; request: string }
}

export interface Dumper {
  isEnabled(): boolean
  setEnabled(enabled: boolean): void
  /**
   * Write `<id>.body.json`, `<id>.meta.json` and `<id>.request.json`. Returns
   * undefined when dumps are off or the write failed; dumping is diagnostic
   * and never throws into the request path.
   */
  dump(input: DumpInput): Promise<DumpResult | undefined>
}

const PREVIOUS_BODY_LIMIT = 100
const UNKNOWN_SESSION = 'session-unknown'

function shortSession(session: string): string {
  return session.length <= 16 ? session : `${session.slice(0, 12)}…`
}

function fileSegment(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!normalized) return fallback
  return normalized.slice(0, 80)
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Where two bodies first and last differ, in string offsets into the dumped
 * (redacted) text. Offsets count UTF-16 units, as the plugins' cache analysis
 * always has.
 */
export function diffDumpBodies(
  previous: string | undefined,
  current: string,
): DumpDiff | null {
  if (previous === undefined) return null
  if (previous === current) {
    return {
      changed: false,
      firstByte: -1,
      lastPreviousByte: -1,
      lastCurrentByte: -1,
      previousBytes: previous.length,
      currentBytes: current.length,
    }
  }
  let firstByte = 0
  while (
    firstByte < previous.length &&
    firstByte < current.length &&
    previous[firstByte] === current[firstByte]
  ) {
    firstByte++
  }
  let previousTail = previous.length - 1
  let currentTail = current.length - 1
  while (
    previousTail >= firstByte &&
    currentTail >= firstByte &&
    previous[previousTail] === current[currentTail]
  ) {
    previousTail--
    currentTail--
  }
  return {
    changed: true,
    firstByte,
    lastPreviousByte: previousTail,
    lastCurrentByte: currentTail,
    changedPreviousBytes: previousTail - firstByte + 1,
    changedCurrentBytes: currentTail - firstByte + 1,
    previousBytes: previous.length,
    currentBytes: current.length,
  }
}

export function createDumper(options: DumpOptions): Dumper {
  let enabled = options.enabled === true
  let counter = 0
  const pid = options.pid ?? process.pid
  const now = options.now ?? Date.now
  const log = options.logger
  const extraKeys = new Set((options.secretKeys ?? []).map(normalizeKey))
  const redactor = createRedactor({
    extraSecretKeys: (normalized) => extraKeys.has(normalized),
    extraValuePatterns: [...(options.secretPatterns ?? [])],
  })
  const schemaKeys = new Set(options.schemaKeys ?? ['tools'])
  /**
   * Last dumped (redacted) body per baseline key, in memory for this process.
   * A key missing here, on its first dump or after eviction, is looked up on
   * disk.
   */
  const previousBodies = new Map<string, string>()

  const resolveDir = () =>
    typeof options.dir === 'function' ? options.dir() : options.dir

  /** The mask for a secret key name, or undefined for an ordinary key. */
  function maskFor(key: string): unknown {
    // The shared redactor masks a secret key whatever its value, so probing it
    // with null answers "is this key a secret" without duplicating its rules.
    const masked = (
      redactor.redact({ [key]: null }) as Record<string, unknown>
    )[key]
    return masked === null ? undefined : masked
  }

  /**
   * Redact by key name and scrub token-shaped strings, except below a schema
   * key, where only strings are scrubbed: a tool parameter named `api_key`
   * declares what the tool accepts, and masking that node would leave a
   * schema that no longer parses. Key order is kept because dumps are diffed
   * against each other.
   */
  function scrub(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(scrub)
    if (isRecord(value)) {
      const out: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(value)) {
        const mask = maskFor(key)
        if (schemaKeys.has(key)) out[key] = redactor.redactStrings(entry)
        else if (mask !== undefined) out[key] = mask
        else out[key] = scrub(entry)
      }
      return out
    }
    return redactor.redactStrings(value)
  }

  function scrubBody(bodyText: string): {
    text: string
    parsed: Record<string, unknown> | undefined
  } {
    let parsed: unknown
    try {
      parsed = JSON.parse(bodyText)
    } catch {
      // Not JSON: no keys to judge, but token-shaped strings still go.
      return {
        text: redactor.redactStrings(bodyText) as string,
        parsed: undefined,
      }
    }
    const scrubbed = scrub(parsed)
    const scrubbedText = JSON.stringify(scrubbed)
    // Nothing redacted: keep the original bytes, whitespace included, so the
    // dump is exactly what was sent.
    const text =
      JSON.stringify(parsed) === scrubbedText ? bodyText : scrubbedText
    return { text, parsed: isRecord(scrubbed) ? scrubbed : undefined }
  }

  /**
   * The newest earlier dump of this baseline key, read back from the dump
   * directory. The in-memory baseline dies with the process, and the first
   * request after a restart is the one most likely to break the prompt cache,
   * so it is the one whose diff matters most. Reading the dumps themselves
   * needs no extra state, and clearing the directory clears the baseline with
   * it. Any failure is no baseline.
   */
  async function recoverBaseline(
    dir: string,
    session: string,
    channel: string,
    baselineKey: string,
  ): Promise<string | undefined> {
    const marker = `-${fileSegment(session, UNKNOWN_SESSION)}-${fileSegment(channel, 'channel')}`
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return undefined
    }
    // Names start with an ISO timestamp, so reverse lexicographic order is
    // newest first. The metadata's key decides the match: a filename segment
    // is truncated and sanitised, so two sessions can share one.
    const candidates = names
      .filter((name) => name.endsWith('.meta.json') && name.includes(marker))
      .sort()
      .reverse()
    for (const name of candidates) {
      try {
        const metadata = JSON.parse(await readFile(join(dir, name), 'utf8'))
        if (metadata?.baselineKey !== baselineKey) continue
        return await readFile(
          join(dir, name.replace(/\.meta\.json$/, '.body.json')),
          'utf8',
        )
      } catch {
        // A file removed or half-written by another process: try the next.
      }
    }
    return undefined
  }

  function remember(key: string, text: string): void {
    if (!previousBodies.has(key)) {
      while (previousBodies.size >= PREVIOUS_BODY_LIMIT) {
        const oldest = previousBodies.keys().next().value
        if (oldest === undefined) break
        previousBodies.delete(oldest)
      }
    }
    previousBodies.set(key, text)
  }

  async function dump(input: DumpInput): Promise<DumpResult | undefined> {
    if (!enabled) return undefined
    counter++
    const session = input.session?.trim() || UNKNOWN_SESSION
    const dir = resolveDir()
    const createdAt = new Date(now()).toISOString()
    // The pid makes names unique across processes: each process starts its
    // counter at zero, so two processes dumping the same session in the same
    // millisecond into a shared directory would otherwise pick the same name.
    const id = [
      createdAt.replace(/[:.]/g, '-'),
      String(pid),
      String(counter).padStart(6, '0'),
      fileSegment(session, UNKNOWN_SESSION),
      fileSegment(input.channel, 'channel'),
      ...(input.phase ? [fileSegment(input.phase, 'phase')] : []),
    ].join('-')
    const prefix = join(dir, id)
    const files = {
      body: `${prefix}.body.json`,
      metadata: `${prefix}.meta.json`,
      request: `${prefix}.request.json`,
    }
    // Hashed so the metadata identifies the baseline without spelling out the
    // full session id.
    const baselineKey = hashText(`${input.channel}\u0000${session}`)

    try {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      // mkdir's mode does not apply to a directory that already exists.
      await chmod(dir, 0o700)

      let previous = previousBodies.get(baselineKey)
      let baselineSource: 'memory' | 'disk' | undefined =
        previous === undefined ? undefined : 'memory'
      if (previous === undefined) {
        previous = await recoverBaseline(
          dir,
          session,
          input.channel,
          baselineKey,
        )
        if (previous !== undefined) baselineSource = 'disk'
      }

      const body = scrubBody(input.bodyText)
      const metadata = {
        id,
        createdAt,
        pid,
        session: shortSession(session),
        channel: input.channel,
        ...(input.phase ? { phase: input.phase } : {}),
        accountId: input.accountId,
        status: input.status,
        error:
          input.error === undefined
            ? undefined
            : redactor.redactStrings(input.error),
        baselineKey,
        bodyBytes: Buffer.byteLength(input.bodyText, 'utf8'),
        bodyHash: hashText(input.bodyText),
        // Diffed on the redacted text that lands in the body file, so offsets
        // index the file an operator can open, and a baseline read back from
        // disk (also redacted) compares like with like.
        diff: diffDumpBodies(previous, body.text),
        baselineSource,
        body: body.parsed
          ? { parseable: true, ...options.summarize?.(body.parsed) }
          : { parseable: false },
        ...(input.meta ? { extra: scrub(input.meta) } : {}),
        files,
      }
      const request = scrub({
        url: input.url,
        method: input.method,
        accountId: input.accountId,
        headers:
          input.headers === undefined
            ? undefined
            : Object.fromEntries(new Headers(input.headers).entries()),
      })
      // `wx`: a name collision fails loudly instead of overwriting a dump.
      const write = (path: string, text: string) =>
        writeFile(path, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await Promise.all([
        write(files.body, body.text),
        write(files.metadata, `${JSON.stringify(metadata, null, 2)}\n`),
        write(files.request, `${JSON.stringify(request, null, 2)}\n`),
      ])
      remember(baselineKey, body.text)
      log?.debug('dumped request', {
        id,
        session: shortSession(session),
        body: files.body,
      })
      return { id, files }
    } catch (error) {
      log?.warn('request dump failed', {
        session: shortSession(session),
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }

  return {
    isEnabled: () => enabled,
    setEnabled: (value: boolean) => {
      enabled = value
    },
    dump,
  }
}
