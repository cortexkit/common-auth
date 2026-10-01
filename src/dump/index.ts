import { createHash, randomBytes } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
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
  /**
   * Byte cap for the dump artifacts in `dir`. When it is above zero, a sweep
   * runs after a successful dump, at most once per `sweepIntervalMs`, and
   * evicts whole dumps, oldest first, until the artifacts fit. Default off:
   * the directory grows without bound.
   */
  maxBytes?: number
  /** Least time between two automatic sweeps. Default five minutes. */
  sweepIntervalMs?: number
  /**
   * A dump whose newest file is younger than this is never evicted, so a
   * sweep cannot remove a dump whose response is still being attached.
   * Default one minute.
   */
  sweepMinAgeMs?: number
  /**
   * A response staging file older than this is left over from a crashed
   * write and is removed by any sweep, even under the cap. Default ten
   * minutes.
   */
  partialStaleMs?: number
  /**
   * Remove the files a dump did write when another file of the same dump
   * failed, so a failed dump leaves no half group behind. Default false: the
   * files that were written stay.
   */
  cleanupFailedDumps?: boolean
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
  /**
   * Where `dumpResponse` writes this dump's response artifact. Nothing is
   * there until a response is attached.
   */
  responseFile: string
}

/**
 * What a plugin knows about the upstream response to a dumped request. Every
 * field is optional; the artifact holds only what was given, redacted like the
 * request. Pass no response content: the artifact is evidence about the
 * response (who answered, what it cost), not a copy of it.
 */
export interface DumpResponseInput {
  status?: number
  /** The provider's id for the request or response, for support lookups. */
  requestId?: string
  /** The usage block the provider reported. */
  usage?: unknown
  /**
   * False while a stream is still open or when it ended without its final
   * frame. Default true.
   */
  complete?: boolean
  /** Further provider fields, such as the model or the stop reason. */
  fields?: Record<string, unknown>
}

export interface DumpSweepResult {
  removed: number
  freedBytes: number
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
  /**
   * Write the response artifact of an earlier dump as
   * `<id>.response.json`, replacing any earlier one, so a stream can record
   * its opening usage and later its final usage. Does nothing for an
   * undefined dump. Returns the path, or undefined when the write failed
   * (logged, never thrown).
   */
  dumpResponse(
    dump: DumpResult | undefined,
    input: DumpResponseInput,
  ): Promise<string | undefined>
  /**
   * Apply the byte cap now, whatever the sweep interval. Does nothing when
   * `maxBytes` is not above zero.
   */
  sweep(protectedPaths?: readonly string[]): Promise<DumpSweepResult>
}

const PREVIOUS_BODY_LIMIT = 100
const UNKNOWN_SESSION = 'session-unknown'
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000
const DEFAULT_SWEEP_MIN_AGE_MS = 60 * 1000
const DEFAULT_PARTIAL_STALE_MS = 10 * 60 * 1000

/**
 * The suffixes of the files one dump writes. A dump's files share the name
 * before the suffix, which is how the sweep groups them.
 */
const ARTIFACT_SUFFIX = /\.(body|meta|request|response)\.json$/
/**
 * A dump id: the ISO time with `:` and `.` replaced, the pid, a counter of
 * at least six digits, then the sanitised session, channel and phase. Only
 * names of this shape are swept, so a plugin may point dumps at a directory
 * that also holds other files.
 */
const ARTIFACT_ID =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+-\d{6,}-[a-zA-Z0-9._-]+$/
/** A response staging file: the final name, a random nonce, `.partial`. */
const PARTIAL_SUFFIX = /\.[a-f0-9]{24}\.partial$/

function artifactGroup(name: string): string | undefined {
  const stem = name.replace(ARTIFACT_SUFFIX, '')
  if (stem === name || !ARTIFACT_ID.test(stem)) return undefined
  return stem
}

function isPartialName(name: string): boolean {
  const finalName = name.replace(PARTIAL_SUFFIX, '')
  return finalName !== name && artifactGroup(finalName) !== undefined
}

export interface SweepDumpDirectoryOptions {
  dir: string
  /** Byte cap for the dump artifacts; zero or less disables the sweep. */
  maxBytes: number
  /** Files never removed, such as the dump just written. */
  protectedPaths?: readonly string[]
  /** Milliseconds since the epoch. Default `Date.now()`. */
  now?: number
  /** A dump whose newest file is younger than this is kept. Default one minute. */
  minAgeMs?: number
  /** A response staging file older than this is removed. Default ten minutes. */
  partialStaleMs?: number
  logger?: DumpLogger
}

/**
 * Hold the dump artifacts in `dir` to `maxBytes`. Only file names a dumper
 * writes are counted or removed, so unrelated files in a directory the user
 * chose survive. A dump's files are evicted together, oldest dump first by
 * its newest file, because a body without its metadata (or the reverse) is no
 * use to anyone. Dumps younger than `minAgeMs`, protected paths and symlinks
 * are kept, and a symlinked directory is refused outright. Response staging
 * files left by a crash are reclaimed once stale, even under the cap.
 * Best-effort: a failure removes less, and never throws.
 */
export async function sweepDumpDirectory(
  options: SweepDumpDirectoryOptions,
): Promise<DumpSweepResult> {
  const { dir, maxBytes } = options
  const now = options.now ?? Date.now()
  const minAgeMs = options.minAgeMs ?? DEFAULT_SWEEP_MIN_AGE_MS
  const partialStaleMs = options.partialStaleMs ?? DEFAULT_PARTIAL_STALE_MS
  const empty = { removed: 0, freedBytes: 0 }
  if (!(maxBytes > 0)) return empty

  try {
    if ((await lstat(dir)).isSymbolicLink()) return empty
    const protectedPaths = new Set(
      (options.protectedPaths ?? []).map((path) => resolve(path)),
    )
    const entries = await readdir(dir, { withFileTypes: true })
    type Entry = {
      path: string
      size: number
      mtimeMs: number
      group?: string
    }
    const files: Entry[] = []
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile()) return
        const partial = isPartialName(entry.name)
        const group = partial ? undefined : artifactGroup(entry.name)
        if (!partial && group === undefined) return
        const path = join(dir, entry.name)
        try {
          const stats = await lstat(path)
          if (!stats.isFile()) return
          files.push({ path, size: stats.size, mtimeMs: stats.mtimeMs, group })
        } catch {
          // Another process removed it between the listing and the stat.
        }
      }),
    )

    let total = files.reduce((sum, file) => sum + file.size, 0)
    let removed = 0
    let freedBytes = 0
    const remove = async (file: Entry) => {
      try {
        await unlink(file.path)
        total -= file.size
        freedBytes += file.size
        removed += 1
      } catch {
        // Best-effort: what cannot be removed now is tried again next sweep.
      }
    }

    // A staging file is never a usable dump, so a stale one goes whatever
    // the total; a fresh one may still be renamed into place.
    for (const file of files) {
      if (file.group !== undefined) continue
      if (protectedPaths.has(resolve(file.path))) continue
      if (now - file.mtimeMs < partialStaleMs) continue
      await remove(file)
    }

    const groups = new Map<string, { files: Entry[]; newest: number }>()
    for (const file of files) {
      if (file.group === undefined) continue
      const group = groups.get(file.group) ?? { files: [], newest: 0 }
      group.files.push(file)
      group.newest = Math.max(group.newest, file.mtimeMs)
      groups.set(file.group, group)
    }
    const oldestFirst = [...groups.entries()].sort(
      ([leftName, left], [rightName, right]) =>
        left.newest - right.newest || leftName.localeCompare(rightName),
    )
    for (const [, group] of oldestFirst) {
      if (total <= maxBytes) break
      if (now - group.newest < minAgeMs) continue
      if (group.files.some((file) => protectedPaths.has(resolve(file.path))))
        continue
      for (const file of group.files) await remove(file)
    }

    if (removed > 0) {
      options.logger?.debug('removed old dump files', { removed, freedBytes })
    }
    return { removed, freedBytes }
  } catch {
    return empty
  }
}

/**
 * Replace `path` through a staging file created exclusively next to it, so a
 * reader never sees half a file and a symlink planted at a predictable
 * staging name is never followed.
 */
async function replaceFile(path: string, text: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    const staging = `${path}.${randomBytes(12).toString('hex')}.partial`
    let created = false
    try {
      await writeFile(staging, text, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      })
      created = true
      await rename(staging, path)
      return
    } catch (error) {
      if (created) await unlink(staging).catch(() => {})
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST' && attempt === 0) continue
      throw error
    }
  }
}

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

// Shared by every dumper in the process. A plugin may create one dumper per
// project, and two of them writing the same session in the same millisecond
// would otherwise both number their dump 1 and pick the same file name; the
// exclusive create then drops the second dump.
let processDumpCounter = 0

export function createDumper(options: DumpOptions): Dumper {
  let enabled = options.enabled === true
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
    const counter = ++processDumpCounter
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
      const writes: Array<[string, string]> = [
        [files.body, body.text],
        [files.metadata, `${JSON.stringify(metadata, null, 2)}\n`],
        [files.request, `${JSON.stringify(request, null, 2)}\n`],
      ]
      // Settle every write before judging the group, so a cleanup never
      // races a write that is still in flight.
      const settled = await Promise.allSettled(
        writes.map(([path, text]) => write(path, text)),
      )
      const failed = settled.find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      )
      if (failed) {
        if (options.cleanupFailedDumps) await removeGroup(writes, settled)
        throw failed.reason
      }
      remember(baselineKey, body.text)
      log?.debug('dumped request', {
        id,
        session: shortSession(session),
        body: files.body,
      })
      scheduleSweep(dir, Object.values(files))
      return { id, files, responseFile: `${prefix}.response.json` }
    } catch (error) {
      log?.warn('request dump failed', {
        session: shortSession(session),
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }

  /**
   * Remove what a failed dump wrote. A write that failed with EEXIST found
   * someone else's file at that name and must leave it; any other failure
   * either created nothing or left a partial file of this dump.
   */
  async function removeGroup(
    writes: Array<[string, string]>,
    settled: PromiseSettledResult<void>[],
  ): Promise<void> {
    await Promise.all(
      writes.map(async ([path], index) => {
        const result = settled[index]
        if (
          result?.status === 'rejected' &&
          (result.reason as NodeJS.ErrnoException)?.code === 'EEXIST'
        ) {
          return
        }
        await unlink(path).catch(() => {})
      }),
    )
  }

  const maxBytes = options.maxBytes ?? 0
  const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS
  // Zero, so the first dump of a process sweeps whatever earlier processes
  // left behind.
  let lastSweepAt = 0

  function sweepOptions(
    dir: string,
    protectedPaths: readonly string[] | undefined,
  ): SweepDumpDirectoryOptions {
    return {
      dir,
      maxBytes,
      protectedPaths,
      now: now(),
      minAgeMs: options.sweepMinAgeMs,
      partialStaleMs: options.partialStaleMs,
      logger: log,
    }
  }

  /** Sweep in the background, off the request path, at most once per interval. */
  function scheduleSweep(dir: string, protectedPaths: readonly string[]): void {
    if (!(maxBytes > 0)) return
    const at = now()
    if (at - lastSweepAt < sweepIntervalMs) return
    lastSweepAt = at
    void sweepDumpDirectory(sweepOptions(dir, protectedPaths))
  }

  async function dumpResponse(
    result: DumpResult | undefined,
    input: DumpResponseInput,
  ): Promise<string | undefined> {
    if (!result) return undefined
    const artifact = scrub({
      status: input.status,
      requestId: input.requestId,
      usage: input.usage,
      ...input.fields,
      complete: input.complete ?? true,
    })
    try {
      await replaceFile(
        result.responseFile,
        `${JSON.stringify(artifact, null, 2)}\n`,
      )
      return result.responseFile
    } catch (error) {
      log?.warn('response dump failed', {
        id: result.id,
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
    dumpResponse,
    sweep: (protectedPaths) =>
      sweepDumpDirectory(sweepOptions(resolveDir(), protectedPaths)),
  }
}
