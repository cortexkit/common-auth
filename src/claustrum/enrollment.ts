import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  chmod,
  mkdir,
  open,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from 'node:path'
import {
  ClaustrumCredentialError,
  type ClaustrumClientOptions as ClaustrumEnrollmentClientOptions,
  ClaustrumClient as ClaustrumWireClient,
  type EnrollmentPollOutcome,
  type EnrollmentTokenFile,
  writeEnrollmentTokenFile,
} from '@cortexkit/claustrum-client'
import { acquireRefreshFileLock } from '../fs/index.js'
import { ClaustrumConsumerError } from './errors.js'

const ENROLLMENT_SCHEMA = 1
const ENROLLMENT_FILE_MAX_BYTES = 16 * 1024
const ENROLLMENT_LOCK_TTL_MS = 30_000
const TOKEN_RE = /^[0-9a-f]{64}$/

/**
 * Codes the vault's closed enrollment-refusal vocabulary marks permanent. The
 * client labels some module error frames transient/retry regardless, so the
 * producer's code takes precedence over the client's action for these.
 */
export const TERMINAL_ENROLLMENT_CODES: ReadonlySet<string> = new Set([
  'invalid_params',
  'pending_exists',
  'not_found',
  'already_consumed',
  'superseded',
  'stale_generation',
])

/** Codes that are always worth another ceremony tick, whatever the action says. */
export const RETRYABLE_ENROLLMENT_CODES: ReadonlySet<string> = new Set([
  'pending_queue_full',
])

export type EnrollmentDisposition = 'terminal' | 'retry'

/**
 * Classify an enrollment transport refusal as `(code, disposition)`. The
 * vault's own code wins: a terminal code is terminal even when the client
 * says retry, queue saturation is retryable even when it says gone, and any
 * other code follows the client's action. Errors that are not producer
 * refusals return undefined and are the caller's to rethrow.
 */
export function classifyEnrollmentError(
  error: unknown,
): { code: string; disposition: EnrollmentDisposition } | undefined {
  if (!(error instanceof ClaustrumCredentialError)) return undefined
  if (TERMINAL_ENROLLMENT_CODES.has(error.code))
    return { code: error.code, disposition: 'terminal' }
  if (RETRYABLE_ENROLLMENT_CODES.has(error.code))
    return { code: error.code, disposition: 'retry' }
  return {
    code: error.code,
    disposition: error.action === 'retry' ? 'retry' : 'terminal',
  }
}

/**
 * The name a plugin proposes for one host, for example `openai-auth-opencode`.
 * Each host enrolls separately so the operator can revoke one without the other.
 */
export function enrollmentName(plugin: string, host: string): string {
  if (
    !/^[a-z0-9][a-z0-9-]*$/.test(plugin) ||
    !/^[a-z0-9][a-z0-9-]*$/.test(host)
  )
    throw new ClaustrumConsumerError(
      'invalid-state',
      'Claustrum enrollment names use lowercase letters, digits and dashes',
    )
  return `${plugin}-${host}`
}

export interface ClaustrumEnrollmentClient {
  enrollPropose(input: {
    name: string
    requestSecretHash: string
  }): Promise<{ requestId: string }>
  enrollPoll(input: {
    requestId: string
    requestSecret: string
  }): Promise<EnrollmentPollOutcome>
}

export interface ClaustrumEnrollmentConnection
  extends ClaustrumEnrollmentClient {
  close(): void
}

/**
 * Connect the enrollment ceremony. Setup calls this; the request path never
 * does. `connectionFile` is required because this library reads no
 * environment and knows no host paths.
 */
export function connectClaustrumEnrollmentClient(
  options: ClaustrumEnrollmentClientOptions & { connectionFile: string },
): Promise<ClaustrumEnrollmentConnection> {
  return ClaustrumWireClient.connect(options)
}

interface PendingEnrollmentState {
  version: 1
  phase: 'pending'
  proposedName: string
  requestSecret: string
  requestId?: string
  createdAt: number
  updatedAt: number
}

interface ApprovedEnrollmentState {
  version: 1
  phase: 'approved'
  proposedName: string
  approvedName?: string
  tokenGeneration: number
  updatedAt: number
}

interface TerminalEnrollmentState {
  version: 1
  phase: 'denied' | 'blocked'
  proposedName: string
  errorCode?: string
  updatedAt: number
}

type EnrollmentState =
  | PendingEnrollmentState
  | ApprovedEnrollmentState
  | TerminalEnrollmentState

export type ClaustrumEnrollmentStatus =
  | { state: 'idle' }
  | {
      state: 'pending'
      proposedName: string
      requestId?: string
      retryCode?: string
    }
  | {
      state: 'approved'
      proposedName: string
      approvedName?: string
      tokenGeneration: number
    }
  | { state: 'denied'; proposedName: string }
  | { state: 'blocked'; proposedName: string; code: string }
  | { state: 'unavailable'; proposedName: string; code: string }
  | { state: 'busy' }

export interface ClaustrumEnrollmentPaths {
  statePath: string
  tokenPath: string
}

/** The ceremony state file sits next to the token: `x.json` pairs with `x-state.json`. */
export function getClaustrumEnrollmentPaths(
  tokenPath: string,
): ClaustrumEnrollmentPaths {
  const extension = extname(tokenPath) || '.json'
  const stem = basename(tokenPath, extname(tokenPath))
  return {
    statePath: join(dirname(tokenPath), `${stem}-state${extension}`),
    tokenPath,
  }
}

/**
 * One host's token and state paths. Every host gets its own pair under the
 * plugin's state directory, so an OpenCode enrollment and a Pi enrollment can
 * be approved and revoked independently. A plugin-resolved override replaces
 * the default token path; a relative override resolves against `cwd`.
 */
export function hostEnrollmentPaths(input: {
  stateDir: string
  host: string
  override?: string
  cwd?: string
}): ClaustrumEnrollmentPaths {
  const override = input.override?.trim()
  if (override && !isAbsolute(override) && !input.cwd)
    throw new ClaustrumConsumerError(
      'invalid-state',
      'A relative Claustrum enrollment override needs a base directory',
    )
  const tokenPath = override
    ? isAbsolute(override)
      ? override
      : resolve(input.cwd as string, override)
    : join(input.stateDir, `${input.host}-enrollment.json`)
  return getClaustrumEnrollmentPaths(tokenPath)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function invalidState(): ClaustrumConsumerError {
  return new ClaustrumConsumerError(
    'invalid-state',
    'invalid Claustrum enrollment state',
  )
}

function decodeEnrollmentState(value: unknown): EnrollmentState {
  if (
    !isRecord(value) ||
    value.version !== ENROLLMENT_SCHEMA ||
    typeof value.proposedName !== 'string' ||
    value.proposedName.length === 0
  ) {
    throw invalidState()
  }
  if (value.phase === 'pending') {
    if (
      !TOKEN_RE.test(String(value.requestSecret ?? '')) ||
      (value.requestId !== undefined &&
        (typeof value.requestId !== 'string' ||
          value.requestId.length === 0)) ||
      !validTimestamp(value.createdAt) ||
      !validTimestamp(value.updatedAt)
    ) {
      throw invalidState()
    }
    return {
      version: 1,
      phase: 'pending',
      proposedName: value.proposedName,
      requestSecret: value.requestSecret as string,
      ...(value.requestId !== undefined && {
        requestId: value.requestId as string,
      }),
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    }
  }
  if (value.phase === 'approved') {
    if (
      (value.approvedName !== undefined &&
        (typeof value.approvedName !== 'string' ||
          value.approvedName.length === 0)) ||
      !validGeneration(value.tokenGeneration) ||
      !validTimestamp(value.updatedAt)
    ) {
      throw invalidState()
    }
    return {
      version: 1,
      phase: 'approved',
      proposedName: value.proposedName,
      ...(value.approvedName !== undefined && {
        approvedName: value.approvedName as string,
      }),
      tokenGeneration: value.tokenGeneration,
      updatedAt: value.updatedAt,
    }
  }
  if (value.phase === 'denied' || value.phase === 'blocked') {
    if (
      (value.errorCode !== undefined && typeof value.errorCode !== 'string') ||
      !validTimestamp(value.updatedAt)
    ) {
      throw invalidState()
    }
    return {
      version: 1,
      phase: value.phase,
      proposedName: value.proposedName,
      ...(value.errorCode !== undefined && {
        errorCode: value.errorCode as string,
      }),
      updatedAt: value.updatedAt,
    }
  }
  throw invalidState()
}

function decodeTokenFile(value: unknown): EnrollmentTokenFile {
  if (
    !isRecord(value) ||
    !TOKEN_RE.test(String(value.token ?? '')) ||
    !validGeneration(value.token_generation)
  ) {
    throw new ClaustrumConsumerError(
      'invalid-token',
      'invalid Claustrum enrollment token file',
    )
  }
  return {
    token: value.token as string,
    token_generation: value.token_generation,
  }
}

function validateReadableSecretFile(metadata: {
  isFile(): boolean
  mode: number
  uid: number
}): void {
  if (!metadata.isFile()) {
    throw new ClaustrumConsumerError(
      'unsafe-file',
      'Claustrum enrollment file must be a regular file',
    )
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new ClaustrumConsumerError(
      'unsafe-file',
      'Claustrum enrollment file must be owner-only',
    )
  }
  const expectedUid = process.getuid?.()
  if (expectedUid !== undefined && metadata.uid !== expectedUid) {
    throw new ClaustrumConsumerError(
      'unsafe-file',
      'Claustrum enrollment file must be owned by the current user',
    )
  }
}

/** Parse secret-bearing JSON without letting a parser message echo its bytes. */
function parseSecretJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new ClaustrumConsumerError(
      'invalid-state',
      'Claustrum enrollment file is not valid JSON',
    )
  }
}

async function readBoundedJson(path: string): Promise<unknown | undefined> {
  let descriptor: Awaited<ReturnType<typeof open>> | undefined
  try {
    // O_NOFOLLOW: a symlink planted at the path must not redirect a secret read.
    descriptor = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new ClaustrumConsumerError(
      'unsafe-file',
      'Claustrum enrollment file could not be opened safely',
    )
  }
  try {
    validateReadableSecretFile(await descriptor.stat())
    const source = Buffer.alloc(ENROLLMENT_FILE_MAX_BYTES + 1)
    const { bytesRead } = await descriptor.read(source, 0, source.byteLength, 0)
    if (bytesRead > ENROLLMENT_FILE_MAX_BYTES) {
      throw new ClaustrumConsumerError(
        'unsafe-file',
        'Claustrum enrollment file is too large',
      )
    }
    return parseSecretJson(source.subarray(0, bytesRead).toString('utf8'))
  } finally {
    await descriptor.close()
  }
}

/**
 * Refuse a path below any group- or world-writable directory without the
 * sticky bit: another user could swap the file out from under us there.
 */
async function refuseWritableAncestor(parent: string): Promise<void> {
  let component: string
  try {
    component = await realpath(parent)
  } catch {
    return
  }
  for (;;) {
    const metadata = await stat(component).catch(() => undefined)
    if (
      metadata &&
      (metadata.mode & 0o022) !== 0 &&
      (metadata.mode & 0o1000) === 0
    ) {
      throw new ClaustrumConsumerError(
        'unsafe-file',
        'Claustrum enrollment path has an unsafe writable ancestor',
      )
    }
    const next = dirname(component)
    if (next === component) return
    component = next
  }
}

/**
 * Create the enrollment directory owner-only (0700), and tighten it to 0700
 * when it already exists with group or other bits, so the token and the
 * request secret never sit in a directory another account can list.
 */
async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const metadata = await stat(directory)
  const uid = process.getuid?.()
  if (uid !== undefined && metadata.uid !== uid) {
    throw new ClaustrumConsumerError(
      'unsafe-file',
      'Claustrum enrollment directory must be owned by the current user',
    )
  }
  if ((metadata.mode & 0o077) !== 0) await chmod(directory, 0o700)
}

async function writeStateAtomic(
  path: string,
  state: EnrollmentState,
): Promise<void> {
  const parent = dirname(path)
  await ensurePrivateDirectory(parent)
  await refuseWritableAncestor(parent)
  const bytes = `${JSON.stringify(state)}\n`
  if (Buffer.byteLength(bytes) > ENROLLMENT_FILE_MAX_BYTES) {
    throw new ClaustrumConsumerError(
      'invalid-state',
      'Claustrum enrollment state is too large',
    )
  }
  const temporary = join(
    parent,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  )
  let descriptor: Awaited<ReturnType<typeof open>> | undefined
  let created = false
  try {
    descriptor = await open(temporary, 'wx', 0o600)
    created = true
    await descriptor.writeFile(bytes, 'utf8')
    await descriptor.chmod(0o600)
    await descriptor.sync()
    await descriptor.close()
    descriptor = undefined
    await rename(temporary, path)
    created = false
  } finally {
    await descriptor?.close().catch(() => {})
    if (created) await unlink(temporary).catch(() => {})
  }
}

export async function readClaustrumEnrollmentStatus(
  paths: ClaustrumEnrollmentPaths,
  proposedName: string,
): Promise<ClaustrumEnrollmentStatus> {
  const tokenValue = await readBoundedJson(paths.tokenPath)
  const token =
    tokenValue === undefined ? undefined : decodeTokenFile(tokenValue)
  const stateValue = await readBoundedJson(paths.statePath)
  const state =
    stateValue === undefined ? undefined : decodeEnrollmentState(stateValue)
  if (token) {
    return {
      state: 'approved',
      proposedName: state?.proposedName ?? proposedName,
      ...(state?.phase === 'approved' &&
        state.approvedName !== undefined && {
          approvedName: state.approvedName,
        }),
      tokenGeneration: token.token_generation,
    }
  }
  if (!state) return { state: 'idle' }
  if (state.phase === 'approved') {
    return {
      state: 'blocked',
      proposedName: state.proposedName,
      code: 'missing_token',
    }
  }
  return statusFromState(state)
}

/**
 * Read fresh bearer material for one scoped operation; never publish it.
 * Re-reading per operation is what lets an operator reissue a token on disk.
 */
export async function readClaustrumEnrollmentToken(
  tokenPath: string,
): Promise<EnrollmentTokenFile> {
  await refuseWritableAncestor(tokenPath)
  const value = await readBoundedJson(tokenPath)
  if (value === undefined)
    throw new ClaustrumConsumerError(
      'not-enrolled',
      'Claustrum enrollment is not configured',
    )
  return decodeTokenFile(value)
}

function statusFromState(state: EnrollmentState): ClaustrumEnrollmentStatus {
  if (state.phase === 'pending') {
    return {
      state: 'pending',
      proposedName: state.proposedName,
      ...(state.requestId !== undefined && { requestId: state.requestId }),
    }
  }
  if (state.phase === 'approved') {
    return {
      state: 'approved',
      proposedName: state.proposedName,
      ...(state.approvedName !== undefined && {
        approvedName: state.approvedName,
      }),
      tokenGeneration: state.tokenGeneration,
    }
  }
  if (state.phase === 'denied')
    return { state: 'denied', proposedName: state.proposedName }
  return {
    state: 'blocked',
    proposedName: state.proposedName,
    code: state.errorCode ?? 'unknown',
  }
}

function wrongConsumer(): ClaustrumConsumerError {
  return new ClaustrumConsumerError(
    'wrong-consumer',
    'Claustrum enrollment state belongs to a different consumer',
  )
}

/**
 * The enrollment ceremony for one host. Run it from setup only: it proposes,
 * polls and persists, and every step can wait on an operator. The request
 * path reads the resulting token and never calls into this class.
 */
export class ClaustrumEnrollmentManager {
  readonly #client: ClaustrumEnrollmentClient
  readonly #paths: ClaustrumEnrollmentPaths
  readonly #proposedName: string
  readonly #now: () => number
  readonly #mintSecret: () => string
  readonly #writeTokenFile: typeof writeEnrollmentTokenFile

  constructor(options: {
    client: ClaustrumEnrollmentClient
    paths: ClaustrumEnrollmentPaths
    proposedName: string
    now?: () => number
    mintSecret?: () => string
    writeTokenFile?: typeof writeEnrollmentTokenFile
  }) {
    this.#client = options.client
    this.#paths = options.paths
    this.#proposedName = options.proposedName
    this.#now = options.now ?? Date.now
    this.#mintSecret =
      options.mintSecret ?? (() => randomBytes(32).toString('hex'))
    this.#writeTokenFile = options.writeTokenFile ?? writeEnrollmentTokenFile
  }

  async status(): Promise<ClaustrumEnrollmentStatus> {
    return readClaustrumEnrollmentStatus(this.#paths, this.#proposedName)
  }

  async resetTerminal(): Promise<ClaustrumEnrollmentResetResult> {
    return resetClaustrumEnrollmentState(this.#paths, this.#proposedName)
  }

  async #block(
    state: PendingEnrollmentState,
    code: string,
  ): Promise<ClaustrumEnrollmentStatus> {
    // Writing the terminal phase drops the request secret from disk.
    const blocked: TerminalEnrollmentState = {
      version: 1,
      phase: 'blocked',
      proposedName: state.proposedName,
      errorCode: code,
      updatedAt: this.#now(),
    }
    await writeStateAtomic(this.#paths.statePath, blocked)
    return statusFromState(blocked)
  }

  async reconcile(): Promise<ClaustrumEnrollmentStatus> {
    await ensurePrivateDirectory(dirname(this.#paths.statePath))
    const lock = await acquireRefreshFileLock({
      name: 'ceremony',
      path: this.#paths.statePath,
      ttlMs: ENROLLMENT_LOCK_TTL_MS,
      renew: true,
    })
    if (!lock) return { state: 'busy' }
    try {
      const existingToken = await readBoundedJson(this.#paths.tokenPath)
      const token =
        existingToken === undefined ? undefined : decodeTokenFile(existingToken)
      const stateValue = await readBoundedJson(this.#paths.statePath)
      let state =
        stateValue === undefined ? undefined : decodeEnrollmentState(stateValue)
      if (state && state.proposedName !== this.#proposedName)
        throw wrongConsumer()
      if (token) {
        if (!state || state.phase === 'pending') {
          const approved: ApprovedEnrollmentState = {
            version: 1,
            phase: 'approved',
            proposedName: state?.proposedName ?? this.#proposedName,
            tokenGeneration: token.token_generation,
            updatedAt: this.#now(),
          }
          await writeStateAtomic(this.#paths.statePath, approved)
          state = approved
        }
        return {
          state: 'approved',
          proposedName: state.proposedName,
          ...(state.phase === 'approved' &&
            state.approvedName !== undefined && {
              approvedName: state.approvedName,
            }),
          tokenGeneration: token.token_generation,
        }
      }
      if (state?.phase === 'approved') {
        const blocked: TerminalEnrollmentState = {
          version: 1,
          phase: 'blocked',
          proposedName: state.proposedName,
          errorCode: 'missing_token',
          updatedAt: this.#now(),
        }
        await writeStateAtomic(this.#paths.statePath, blocked)
        return statusFromState(blocked)
      }
      if (state && state.phase !== 'pending') return statusFromState(state)
      if (!state) {
        const now = this.#now()
        state = {
          version: 1,
          phase: 'pending',
          proposedName: this.#proposedName,
          requestSecret: this.#mintSecret(),
          createdAt: now,
          updatedAt: now,
        }
        if (!TOKEN_RE.test(state.requestSecret))
          throw new ClaustrumConsumerError(
            'invalid-state',
            'invalid minted Claustrum enrollment secret',
          )
        // The secret is on disk before the proposal leaves the process: the
        // vault answers a repeated proposal with the same secret with the same
        // request id, so a crash between propose and saving the id costs nothing.
        await writeStateAtomic(this.#paths.statePath, state)
      }

      if (!state.requestId) {
        try {
          const requestSecretHash = createHash('sha256')
            .update(Buffer.from(state.requestSecret, 'hex'))
            .digest('hex')
          const proposed = await this.#client.enrollPropose({
            name: state.proposedName,
            requestSecretHash,
          })
          state = {
            ...state,
            requestId: proposed.requestId,
            updatedAt: this.#now(),
          }
          await writeStateAtomic(this.#paths.statePath, state)
        } catch (error) {
          const refusal = classifyEnrollmentError(error)
          if (!refusal) throw error
          if (refusal.disposition === 'retry') {
            return {
              state: 'pending',
              proposedName: state.proposedName,
              retryCode: refusal.code,
            }
          }
          return this.#block(state, refusal.code)
        }
      }

      const requestId = state.requestId
      if (!requestId) return statusFromState(state)
      try {
        const outcome = await this.#client.enrollPoll({
          requestId,
          requestSecret: state.requestSecret,
        })
        if (outcome.status === 'pending') return statusFromState(state)
        if (outcome.status === 'denied') {
          const denied: TerminalEnrollmentState = {
            version: 1,
            phase: 'denied',
            proposedName: state.proposedName,
            updatedAt: this.#now(),
          }
          await writeStateAtomic(this.#paths.statePath, denied)
          return statusFromState(denied)
        }
        // The vault returns the token exactly once: it reaches disk before the
        // pending metadata (and its secret) is replaced.
        await this.#writeTokenFile(this.#paths.tokenPath, {
          token: outcome.token,
          token_generation: outcome.tokenGeneration,
        })
        const approved: ApprovedEnrollmentState = {
          version: 1,
          phase: 'approved',
          proposedName: state.proposedName,
          approvedName: outcome.name,
          tokenGeneration: outcome.tokenGeneration,
          updatedAt: this.#now(),
        }
        await writeStateAtomic(this.#paths.statePath, approved)
        return statusFromState(approved)
      } catch (error) {
        const refusal = classifyEnrollmentError(error)
        if (!refusal) throw error
        if (refusal.disposition === 'retry') {
          return {
            state: 'pending',
            proposedName: state.proposedName,
            requestId,
            retryCode: refusal.code,
          }
        }
        return this.#block(state, refusal.code)
      }
    } finally {
      await lock.release()
    }
  }
}

export type ClaustrumEnrollmentResetResult =
  | 'reset'
  | 'idle'
  | 'refused-pending'
  | 'refused-approved'
  | 'busy'

/** Reset local terminal metadata without connecting to the credential daemon. */
export async function resetClaustrumEnrollmentState(
  paths: ClaustrumEnrollmentPaths,
  proposedName: string,
): Promise<ClaustrumEnrollmentResetResult> {
  await ensurePrivateDirectory(dirname(paths.statePath))
  const lock = await acquireRefreshFileLock({
    name: 'ceremony',
    path: paths.statePath,
    ttlMs: ENROLLMENT_LOCK_TTL_MS,
    renew: true,
  })
  if (!lock) return 'busy'
  try {
    if ((await readBoundedJson(paths.tokenPath)) !== undefined)
      return 'refused-approved'
    const value = await readBoundedJson(paths.statePath)
    if (value === undefined) return 'idle'
    const state = decodeEnrollmentState(value)
    if (state.proposedName !== proposedName) throw wrongConsumer()
    if (state.phase === 'pending') return 'refused-pending'
    await lock.assertOwned()
    await unlink(paths.statePath)
    return 'reset'
  } finally {
    await lock.release()
  }
}
