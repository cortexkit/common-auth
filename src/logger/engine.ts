import {
  appendFileSync,
  chmodSync,
  existsSync,
  renameSync,
  statSync,
} from 'node:fs'
import type { CaptureSink } from './capture-sink.js'
import { createRedactor, type RedactionOptions } from './redact.js'

export type Level = 'error' | 'warn' | 'info' | 'debug' | 'trace'
const ORDER: Record<Level, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
}
const MAX_BYTES = 5 * 1024 * 1024
const ROTATE_KEEP = 3

interface LoggerOptionsBase extends RedactionOptions {
  /** Level floor applied when no `setLogLevel` call has overridden it. */
  level?: Level | (() => Level | undefined)
}

interface FileLoggerOptions {
  /** Receives every emitted record, scrubbed, alongside the file. */
  captureSink?: CaptureSink
  /**
   * Path of the file lines are appended to, or a function returning it.
   *
   * A function is what a host passes when its destination can move while the
   * process runs — an operator or a test changing the variable that names the
   * log file expects the next line to land in the new file, and a value
   * captured once at init would keep writing to the old one.
   */
  file: string | (() => string)
}

interface SinkOnlyLoggerOptions {
  /**
   * Receives every emitted record, scrubbed. With no `file`, this sink is
   * the logger's only destination: nothing is written to disk or printed,
   * for a host that forwards records to its own log.
   */
  captureSink: CaptureSink
  file?: undefined
}

/** A logger writes to a file, to a capture sink, or to both. */
export type InitLoggerOptions = LoggerOptionsBase &
  (FileLoggerOptions | SinkOnlyLoggerOptions)

export interface ChannelLogger {
  error(message: string, data?: unknown): void
  warn(message: string, data?: unknown): void
  info(message: string, data?: unknown): void
  debug(message: string, data?: unknown): void
  trace(message: string, data?: unknown): void
}

/**
 * A logger with its own file, level, redaction, capture sink and buffer.
 * Two instances in one process never touch each other's settings or lines,
 * so two plugins that load one shared copy of this module each keep their own
 * log by holding their own instance.
 */
export interface LoggerInstance {
  /** A logger whose lines carry `channel` and go to this instance's file. */
  createLogger(channel: string): ChannelLogger
  /**
   * Point this instance at a host's file and level. Idempotent: calling it
   * again replaces both. A runtime level installed by `setLogLevel` is left
   * alone, because it is the operator's explicit choice and outranks the
   * floor a host computed at start-up.
   */
  configure(options: InitLoggerOptions): void
  /** Operator override of the level floor; undefined removes it. */
  setLogLevel(level: Level | undefined): void
  /**
   * Write whatever is buffered. Safe to call synchronously from a
   * process-exit handler, which is how each host drains the buffer on
   * shutdown.
   */
  flushLogs(): void
}

function chmodPrivate(path: string) {
  try {
    chmodSync(path, 0o600)
  } catch {
    /* never throw */
  }
}
function rotateIfNeeded(f: string) {
  try {
    if (!(existsSync(f) && statSync(f).size >= MAX_BYTES)) return
    for (let i = ROTATE_KEEP - 1; i >= 1; i--) {
      if (existsSync(`${f}.${i}`)) {
        const rotated = `${f}.${i + 1}`
        renameSync(`${f}.${i}`, rotated)
        chmodPrivate(rotated)
      }
    }
    const rotated = `${f}.1`
    renameSync(f, rotated)
    chmodPrivate(rotated)
  } catch {
    /* never throw */
  }
}

function safeSerialize(data: unknown): string {
  try {
    return ` ${JSON.stringify(data)}`
  } catch {
    return ' [unserializable]'
  }
}

interface Engine extends LoggerInstance {
  reset(): void
}

/**
 * One logger's settings and buffer.
 *
 * Where lines are written and the level floor start unset unless `options`
 * supplies them. A host decides where its log lives (that decision reads host
 * environment variables and host directories, neither of which belongs in
 * shared code) and configures the logger before it runs any command. Until
 * then every `log.*` call is a silent no-op: throwing would turn the first
 * command a host forgot to wire into a crash, and buffering would hold
 * credential-bearing lines for a configuration that may never arrive.
 */
function createEngine(options?: InitLoggerOptions): Engine {
  let logFileSource: string | (() => string) | undefined
  let initLevelSource: Level | (() => Level | undefined) | undefined
  let runtimeLevel: Level | undefined
  let redactor = createRedactor()
  let captureSink: CaptureSink | undefined
  let buffer: string[] = []
  let timer: ReturnType<typeof setTimeout> | undefined

  function configure(next: InitLoggerOptions): void {
    logFileSource = next.file
    initLevelSource = next.level
    redactor = createRedactor(next)
    captureSink = next.captureSink
  }

  function setLogLevel(l: Level | undefined) {
    if (l === undefined || l in ORDER) runtimeLevel = l
  }

  function logFilePath(): string | undefined {
    if (logFileSource === undefined) return undefined
    const resolved =
      typeof logFileSource === 'function' ? logFileSource() : logFileSource
    return resolved || undefined
  }

  function configuredLevel(): Level {
    if (runtimeLevel) return runtimeLevel
    const floor =
      typeof initLevelSource === 'function'
        ? initLevelSource()
        : initLevelSource
    if (floor && floor in ORDER) return floor
    return 'info'
  }

  function flushLogs() {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    if (!buffer.length) return
    let file: string | undefined
    try {
      file = logFilePath()
    } catch {
      buffer = []
      return
    }
    const text = buffer.join('')
    buffer = []
    if (!file) return
    try {
      rotateIfNeeded(file)
      if (existsSync(file)) chmodPrivate(file)
      appendFileSync(file, text, { encoding: 'utf8', mode: 0o600 })
    } catch {
      /* never throw */
    }
  }

  function schedule() {
    if (!timer)
      timer = setTimeout(() => {
        timer = undefined
        flushLogs()
      }, 500)
  }

  function emit(
    channel: string,
    level: Level,
    message: string,
    data?: unknown,
  ) {
    // Unconfigured (neither a file nor a sink) stays a silent no-op.
    if (logFileSource === undefined && captureSink === undefined) return
    try {
      if (ORDER[level] > ORDER[configuredLevel()]) return
      const scrubbedMessage = redactor.redactStrings(message) as string
      let scrubbedData: unknown
      try {
        scrubbedData = redactor.redact(data)
      } catch {
        scrubbedData = '[unserializable]'
      }
      const line =
        `[${new Date().toISOString()}] ${level.toUpperCase()} [${channel}] ${scrubbedMessage}` +
        (data === undefined ? '' : safeSerialize(scrubbedData)) +
        '\n'
      // A failing observer must not prevent file logging or escape into the host.
      try {
        captureSink?.({
          channel,
          level,
          message: scrubbedMessage,
          data: scrubbedData,
        })
      } catch {}
      // A sink-only logger has no file to buffer lines for.
      if (logFileSource === undefined) return
      buffer.push(line)
      if (buffer.length >= 50) flushLogs()
      else schedule()
    } catch {
      // Provider and redaction failures must never turn diagnostics into a host crash.
    }
  }

  function createLogger(channel: string): ChannelLogger {
    return {
      error: (m: string, d?: unknown) => emit(channel, 'error', m, d),
      warn: (m: string, d?: unknown) => emit(channel, 'warn', m, d),
      info: (m: string, d?: unknown) => emit(channel, 'info', m, d),
      debug: (m: string, d?: unknown) => emit(channel, 'debug', m, d),
      trace: (m: string, d?: unknown) => emit(channel, 'trace', m, d),
    }
  }

  function reset() {
    buffer = []
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    logFileSource = undefined
    initLevelSource = undefined
    runtimeLevel = undefined
    redactor = createRedactor()
    captureSink = undefined
  }

  if (options) configure(options)
  return { configure, createLogger, setLogLevel, flushLogs, reset }
}

/**
 * A logger instance of its own, configured with `options`. A plugin whose
 * copy of this module may be shared with another plugin in the same process
 * uses this instead of `initLogger`, so neither replaces the other's file,
 * level, redaction or capture sink.
 */
export function createLoggerInstance(
  options: InitLoggerOptions,
): LoggerInstance {
  const { configure, createLogger, setLogLevel, flushLogs } =
    createEngine(options)
  return { configure, createLogger, setLogLevel, flushLogs }
}

/**
 * The instance behind the module-level functions below, which keep the
 * single-plugin API: one plugin per copy of this module calls `initLogger`
 * and `createLogger` without holding an instance.
 */
const defaultEngine = createEngine()

/**
 * Point the module's default logger at a host's file and level, and return
 * it. Idempotent: calling it again replaces both. A runtime level installed
 * by `setLogLevel` is deliberately left alone, because it is the operator's
 * explicit choice and outranks the floor a host computed at start-up.
 */
export function initLogger(options: InitLoggerOptions): LoggerInstance {
  defaultEngine.configure(options)
  const { configure, createLogger, setLogLevel, flushLogs } = defaultEngine
  return { configure, createLogger, setLogLevel, flushLogs }
}

export function setLogLevel(l: Level | undefined) {
  defaultEngine.setLogLevel(l)
}

/**
 * Write whatever the default logger has buffered. Safe to call synchronously
 * from a process-exit handler, which is how each host drains the buffer on
 * shutdown.
 */
export function flushLogs() {
  defaultEngine.flushLogs()
}

export function createLogger(channel: string): ChannelLogger {
  return defaultEngine.createLogger(channel)
}

export async function flushForTest() {
  defaultEngine.flushLogs()
}

/**
 * Return the default logger to its uninitialised state. Only a test needs
 * this: a single process runs every test file, so a file path left over from
 * one test would keep a later "logger was never initialised" case writing
 * lines.
 */
export function resetLoggerForTest() {
  defaultEngine.reset()
}
