import type { LimitSignal as OpenCode2LimitSignal } from '../opencode2/types.js'
import type { LimitSignal } from './signal.js'

/** Pass only reason, status and retryAfterMs to the existing OpenCode 2 adapter. */
export function toOpenCode2LimitSignal(
  signal: LimitSignal,
): OpenCode2LimitSignal {
  return {
    reason: signal.reason,
    ...(signal.status === undefined ? {} : { status: signal.status }),
    ...(signal.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: signal.retryAfterMs }),
  }
}
