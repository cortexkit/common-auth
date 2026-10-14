export { AMBIGUOUS_OPENCODE_MESSAGE, runSetup } from './command.js'
export {
  detectHosts,
  detectOpenCodeGeneration,
  findExecutableOnPath,
  openCodeDesktopMarkers,
} from './detect.js'
export {
  assertHostsStopped,
  createProcessFence,
  ProcessFenceViolationError,
  ProcessInspectionError,
} from './process-fence.js'
export {
  type PlannedWrite,
  planOpenCodeRegistration,
  registerOpenCode,
  registerPi,
  updatePluginConfig,
} from './register.js'
export type {
  CommandResult,
  CommandRunner,
  HostDetection,
  OpenCodeGeneration,
  ProcessFence,
  SetupDetection,
  SetupEnvironment,
  SetupFileSystem,
  SetupHost,
  SetupIO,
  SetupPlugin,
  SetupResult,
} from './types.js'
