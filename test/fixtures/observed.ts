import type { TestLifetime } from './test-lifetime.js'

/** Let the runner own the deadline while allowing teardown to drain a missing observation. */
export async function observed<T>(
  lifetime: TestLifetime,
  promise: Promise<T>,
): Promise<T> {
  return Promise.race([
    promise,
    lifetime.untilCancelled().then(() => {
      throw new Error(
        'Expected observation was not received before test cancellation',
      )
    }),
  ])
}

/** Poll state, not elapsed time; the delay only yields between observations. */
export async function observedState(
  lifetime: TestLifetime,
  check: () => boolean | Promise<boolean>,
): Promise<void> {
  while (!lifetime.signal.aborted) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Expected state was not observed before test cancellation')
}
