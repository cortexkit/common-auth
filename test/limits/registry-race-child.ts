import type {
  LimitsClock,
  LimitsPersistenceCommit,
} from '../../src/limits/index.js'
import { runChild, type Scenario } from '../store/helpers.js'

/** Advance the registry's debounce timer only after the child has committed. */
export class RaceClock implements LimitsClock {
  private time = 100
  private sequence = 0
  private readonly timers = new Map<
    number,
    { at: number; callback: () => void }
  >()

  now = () => this.time

  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.sequence
    this.timers.set(id, { at: this.time + delayMs, callback })
    return id
  }

  clearTimeout(timer: unknown): void {
    this.timers.delete(timer as number)
  }

  advance(ms: number): void {
    this.time += ms
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.time && this.timers.delete(id)) timer.callback()
    }
  }
}

export async function changeInChild(
  task: Record<string, unknown>,
): Promise<void> {
  const child = runChild(task)
  const code = await child.exited
  if (code !== 0) throw new Error(`Child exited ${code}: ${child.output()}`)
}

/** Use the store child fixture to clear, then resume it and wait for its exit. */
export async function clearInChild(
  s: Scenario,
  kind: 'pool' | 'vault',
  namespace: string,
  path: string,
): Promise<LimitsPersistenceCommit> {
  const child = runChild({
    ...s.paths,
    op: 'limits-envelope-loss',
    kind,
    namespace,
    path,
  })
  let result: LimitsPersistenceCommit
  let code: number | null
  try {
    await Promise.race([
      child.printed('cleared:'),
      child.exited.then((code) => {
        throw new Error(
          `Child exited before clear (${code}): ${child.output()}`,
        )
      }),
    ])
    const line = child
      .output()
      .split('\n')
      .find((row) => row.startsWith('cleared:'))
    if (!line)
      throw new Error(`Missing clear acknowledgement: ${child.output()}`)
    result = JSON.parse(
      line.slice('cleared:'.length),
    ) as LimitsPersistenceCommit
  } finally {
    child.continue()
    code = await child.exited
  }
  if (code !== 0) throw new Error(`Child exited ${code}: ${child.output()}`)
  return result
}
