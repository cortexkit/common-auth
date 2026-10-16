import { redact } from '../logger/redact.js'
import { STDERR_TAIL_MAX_BYTES } from './command-runner.js'

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

export class SetupCommandError extends Error {
  readonly step = 'pi-install'
  readonly exitCode: number | null
  readonly signal: string | null
  readonly stderrTail: string

  constructor(details: {
    exitCode: number | null
    signal: string | null
    stderrTail: string
  }) {
    super(PI_INSTALL_ERROR_MESSAGE)
    this.name = 'SetupCommandError'
    this.exitCode = details.exitCode
    this.signal = details.signal
    const redacted = redact(details.stderrTail)
    this.stderrTail = utf8Tail(typeof redacted === 'string' ? redacted : '')
  }
}
