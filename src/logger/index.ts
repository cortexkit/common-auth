export type { CaptureSink, LogTestRecord } from './capture-sink.js'
export { createCaptureSink } from './capture-sink.js'
export type { InitLoggerOptions, Level } from './engine.js'
export {
  createLogger,
  flushForTest,
  flushLogs,
  initLogger,
  resetLoggerForTest,
  setLogLevel,
} from './engine.js'
export type { RedactionOptions, Redactor } from './redact.js'
export { createRedactor, redact, redactStrings } from './redact.js'
