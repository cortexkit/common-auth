import { lstat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import type { RpcLogChannel } from './index.js'
import { sweepRpcDirectory, sweepRpcState } from './port-file.js'

interface SweepState {
  lastSweepAt?: number
}

const globals = globalThis as unknown as Record<symbol, SweepState | undefined>
const key = Symbol.for('common-auth.rpc.startup-sweep')
globals[key] ??= {}
const state = globals[key]
let now = Date.now

/** Internal clock seam; reset the process-wide budget between tests. */
export function resetRpcSweepForTest(clock: () => number = Date.now): void {
  now = clock
  delete state.lastSweepAt
}

export async function sweepRpcStateOnStart(
  root: string,
  activeDir: string,
  isManagedDir: (name: string) => boolean,
  log: RpcLogChannel,
): Promise<void> {
  const time = now()
  if (state.lastSweepAt !== undefined && time - state.lastSweepAt < 60_000) {
    // The starting folder still needs corrupt, dead and pre-boot records removed.
    const active = resolve(activeDir)
    if (
      dirname(active) === resolve(root) &&
      isManagedDir(basename(active)) &&
      (
        await lstat(active).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
          return undefined
        })
      )?.isDirectory()
    )
      await sweepRpcDirectory(active, log)
    return
  }
  // Claim before awaiting I/O so concurrent starts cannot all scan sibling folders.
  state.lastSweepAt = time
  await sweepRpcState(root, activeDir, isManagedDir, log)
}
