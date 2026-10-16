import { spawn } from 'node:child_process'
import type { CommandResult, CommandRunner, SetupEnvironment } from './types.js'

export const STDERR_TAIL_MAX_BYTES = 4 * 1024
const STDOUT_MAX_BYTES = 1024 * 1024

class ByteTail {
  private readonly buffer = Buffer.alloc(STDERR_TAIL_MAX_BYTES)
  private start = 0
  private length = 0
  private truncated = false

  get didTruncate(): boolean {
    return this.truncated
  }

  push(chunk: Buffer): void {
    if (chunk.length >= STDERR_TAIL_MAX_BYTES) {
      if (chunk.length > STDERR_TAIL_MAX_BYTES || this.length > 0)
        this.truncated = true
      chunk.copy(this.buffer, 0, chunk.length - STDERR_TAIL_MAX_BYTES)
      this.start = 0
      this.length = STDERR_TAIL_MAX_BYTES
      return
    }

    const overflow = Math.max(
      0,
      this.length + chunk.length - STDERR_TAIL_MAX_BYTES,
    )
    if (overflow > 0) this.truncated = true
    this.start = (this.start + overflow) % STDERR_TAIL_MAX_BYTES
    this.length -= overflow
    const writeAt = (this.start + this.length) % STDERR_TAIL_MAX_BYTES
    const firstLength = Math.min(chunk.length, STDERR_TAIL_MAX_BYTES - writeAt)
    chunk.copy(this.buffer, writeAt, 0, firstLength)
    if (firstLength < chunk.length) chunk.copy(this.buffer, 0, firstLength)
    this.length += chunk.length
  }

  toString(): string {
    const bytes = Buffer.alloc(this.length)
    const firstLength = Math.min(
      this.length,
      STDERR_TAIL_MAX_BYTES - this.start,
    )
    this.buffer.copy(bytes, 0, this.start, this.start + firstLength)
    if (firstLength < this.length)
      this.buffer.copy(bytes, firstLength, 0, this.length - firstLength)
    let start = 0
    while (start < bytes.length) {
      const byte = bytes[start]
      if (byte === undefined || (byte & 0xc0) !== 0x80) break
      start++
    }
    return bytes.subarray(start).toString('utf8')
  }
}

export const defaultCommandRunner: CommandRunner = {
  run(file, args, options = {}) {
    return new Promise((resolve) => {
      const started = performance.now()
      const timeoutMs = options.timeoutMs ?? 15_000
      const stderr = new ByteTail()
      const stdout: Buffer[] = []
      let stdoutLength = 0
      let outputExceeded = false
      let spawnError = false
      let timedOut = false
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(file, [...args], {
          env: options.env ?? process.env,
          windowsHide: true,
          windowsVerbatimArguments: options.windowsVerbatimArguments,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch {
        resolve({
          exitCode: 1,
          stdout: '',
          stderr: '',
          spawnError: true,
          signal: null,
          timedOut: false,
          durationMs: performance.now() - started,
        })
        return
      }

      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true
              child.kill('SIGTERM')
            }, timeoutMs)
          : undefined
      child.stdout?.on('data', (chunk: Buffer) => {
        const remaining = STDOUT_MAX_BYTES - stdoutLength
        const length = Math.min(remaining, chunk.length)
        if (length > 0) {
          stdout.push(chunk.subarray(0, length))
          stdoutLength += length
        }
        if (chunk.length > remaining) {
          outputExceeded = true
          child.kill('SIGTERM')
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
      child.once('error', () => {
        spawnError = true
      })
      child.once('close', (code, signal) => {
        if (timer) clearTimeout(timer)
        resolve({
          exitCode: spawnError ? 1 : outputExceeded ? 1 : (code ?? 1),
          stdout: Buffer.concat(stdout, stdoutLength).toString('utf8'),
          stderr: stderr.toString(),
          stderrTruncated: stderr.didTruncate,
          ...(spawnError ? { spawnError: true } : {}),
          signal: signal ?? null,
          timedOut,
          durationMs: performance.now() - started,
        })
      })
    })
  },
}

/** Batch launchers need cmd.exe; no free-form user text is accepted as shell arguments. */
export function runResolvedCommand(
  runner: CommandRunner,
  platform: string,
  file: string,
  args: readonly string[],
  env: SetupEnvironment,
  timeoutMs = 15_000,
): Promise<CommandResult> {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    if (
      /["%!\r\n]/.test(file) ||
      args.some((arg) => !/^[a-zA-Z0-9@:/._+-]+$/.test(arg))
    )
      throw new Error(
        'Unsafe batch launcher or argument; use an executable instead.',
      )
    return runner.run(
      'cmd.exe',
      ['/d', '/s', '/c', `""${file}" ${args.join(' ')}"`],
      {
        env,
        timeoutMs,
        windowsVerbatimArguments: true,
      },
    )
  }
  return runner.run(file, args, { env, timeoutMs })
}
