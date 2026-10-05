import { drainBodies } from './drain-bodies.js'
import type { Scenario } from './helpers.js'

/** Owns test bodies, their store calls, and barriers until teardown is complete. */
export class TestLifetime {
  private readonly bodies = new Set<Promise<unknown>>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly releases: Array<() => void> = []
  private closing = false

  private observe<T>(
    pending: Promise<T>,
    into: Set<Promise<unknown>>,
  ): Promise<T> {
    into.add(pending)
    // The runner may abandon a timed-out body before it awaits a store call.
    // Retain its rejection for draining without making it an unhandled error.
    void pending.catch(() => {})
    return pending
  }

  tracked(body: () => Promise<void>): Promise<void> {
    return this.observe(body(), this.bodies)
  }

  unpark(release: () => void): void {
    if (this.closing) release()
    else this.releases.push(release)
  }

  manage(current: Scenario): Scenario {
    const open = current.open
    return {
      ...current,
      open: (options) => {
        const store = open(options)
        // Include calls whose promises the body never reaches after an assertion
        // fails. Waiting for the body alone cannot drain such detached work.
        return new Proxy(store, {
          get: (target, key, receiver) => {
            const value: unknown = Reflect.get(target, key, receiver)
            if (typeof value !== 'function') return value
            return (...args: unknown[]) => {
              const result: unknown = Reflect.apply(value, target, args)
              return result instanceof Promise
                ? this.observe(result, this.operations)
                : result
            }
          },
        })
      },
    }
  }

  async drain(cleanup: () => void): Promise<void> {
    // Late barriers registered by a body still doing setup must also open.
    this.closing = true
    await drainBodies(this.releases, this.bodies, cleanup, this.operations)
  }
}
