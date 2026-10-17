import { redact } from '../logger/redact.js'
import { STDERR_TAIL_MAX_BYTES } from './command-runner.js'
import type { SetupHostEnrollment } from './types.js'

const PI_INSTALL_ERROR_MESSAGE =
  'Pi install failed; run pi install after checking your npm connection.'

function utf8Tail(value: string): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= STDERR_TAIL_MAX_BYTES) return value
  let start = bytes.length - STDERR_TAIL_MAX_BYTES
  while (start < bytes.length) {
    const byte = bytes[start]
    if (byte === undefined || (byte & 0xc0) !== 0x80) break
    start++
  }
  return bytes.subarray(start).toString('utf8')
}

function dropPartialLine(tail: string): string {
  const newline = tail.indexOf('\n')
  return newline < 0 ? '' : tail.slice(newline + 1)
}

/**
 * Keeps the Pi install refusal message stable while exposing safe process details.
 * A clipped tail can start inside a credential, so discard its first line—or
 * the whole tail if it has no newline—before redacting.
 */
export class SetupCommandError extends Error {
  readonly step = 'pi-install'
  readonly exitCode: number | null
  readonly signal: string | null
  readonly stderrTail: string
  /**
   * Set when the install failed after vault enrollment began for any host:
   * which hosts this run connected to the vault. See `setupEnrollment`.
   */
  declare readonly enrollment?: readonly SetupHostEnrollment[]

  constructor(details: {
    exitCode: number | null
    signal: string | null
    stderrTail: string
    stderrTruncated?: boolean
  }) {
    super(PI_INSTALL_ERROR_MESSAGE)
    this.name = 'SetupCommandError'
    this.exitCode = details.exitCode
    this.signal = details.signal
    const tail = details.stderrTruncated
      ? dropPartialLine(details.stderrTail)
      : details.stderrTail
    const redacted = redact(tail)
    this.stderrTail = utf8Tail(typeof redacted === 'string' ? redacted : '')
  }
}

const HOST_LABELS = { opencode: 'OpenCode', pi: 'Pi' } as const

const OUTCOME_TEXT = {
  enrolled: 'connected to the vault',
  'not-enrolled': 'not connected',
  unknown: 'unknown, check with ck auth status',
} as const

/**
 * Record on a setup failure which hosts are connected to the vault. A host the
 * operator approved stays enrolled after setup fails, so the error says so: the
 * thrown error keeps its identity, class and message text, gains one line per
 * host after that text, and carries the same outcomes as its `enrollment`
 * field. A thrown value that is not an `Error` becomes an `Error` with its
 * text as the message.
 */
export function attachSetupEnrollment(
  failure: unknown,
  enrollment: readonly SetupHostEnrollment[],
): Error {
  const error = failure instanceof Error ? failure : new Error(String(failure))
  const lines = enrollment.map(
    ({ host, outcome }) => `${HOST_LABELS[host]}: ${OUTCOME_TEXT[outcome]}`,
  )
  error.message = [error.message, ...lines].join('\n')
  Object.defineProperty(error, 'enrollment', {
    value: Object.freeze(
      enrollment.map((entry) => Object.freeze({ ...entry })),
    ),
    enumerable: true,
  })
  return error
}

/**
 * The per-host vault enrollment outcomes a failed `runSetup` recorded, or
 * `undefined` when setup failed before any host's enrollment began (or the
 * value is not such an error).
 */
export function setupEnrollment(
  error: unknown,
): readonly SetupHostEnrollment[] | undefined {
  if (!(error instanceof Error) || !Object.hasOwn(error, 'enrollment'))
    return undefined
  const value = (error as { enrollment?: unknown }).enrollment
  return Array.isArray(value)
    ? (value as readonly SetupHostEnrollment[])
    : undefined
}
