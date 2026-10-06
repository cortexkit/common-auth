import { drainBodies } from './drain-bodies.js'

/** Owns bodies, asynchronous operations, and barriers until cleanup is safe. */
export class TestLifetime {
  private readonly bodies = new Set<Promise<unknown>>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly releases: Array<() => void> = []
  private readonly finalizers: Array<() => Promise<unknown>> = []
  private closing = false
  private readonly cancellation = new AbortController()

  /** Cancel test-owned requests before teardown waits for their bodies. */
  get signal(): AbortSignal {
    return this.cancellation.signal
  }

  private observe<T>(
    pending: Promise<T>,
    into: Set<Promise<unknown>>,
  ): Promise<T> {
    into.add(pending)
    // The runner can abandon a timed-out body before it awaits an operation.
    // Observe rejection immediately so it cannot become an error between tests.
    void pending.catch(() => {})
    return pending
  }

  tracked(body: () => unknown): Promise<unknown> {
    const pending = Promise.resolve()
      .then(body)
      .catch((error: unknown) => {
        // After a test deadline, Bun reports a late body rejection as an
        // "Unhandled error between tests" even when it is observed. A teardown
        // abort is expected cancellation, not a second failure of that body.
        // Preserve timer aborts, assertions, and every unrelated rejection.
        if (this.closing && error === this.signal.reason) return
        throw error
      })
    return this.observe(pending, this.bodies)
  }

  operation<T>(pending: Promise<T>): Promise<T> {
    return this.observe(pending, this.operations)
  }

  finish(work: () => Promise<unknown>): void {
    this.finalizers.push(work)
  }

  unpark(release: () => void): void {
    if (this.closing) release()
    else this.releases.push(release)
  }

  manage<T extends object>(current: T): T {
    // Store.load() starts pulls without awaiting them. Its explicit join must
    // also finish before deleting the scenario, including on assertion failure.
    const settle: unknown = Reflect.get(current, 'pullsSettled')
    if (typeof settle === 'function')
      this.finish(() => Reflect.apply(settle, current, []) as Promise<unknown>)
    return new Proxy(current, {
      get: (target, key) => {
        // Private-field getters, like methods, require the original receiver.
        const value: unknown = Reflect.get(target, key, target)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          const result: unknown = Reflect.apply(value, target, args)
          if (result instanceof Promise) return this.operation(result)
          // Factories such as scenario.open() return a resource with its own
          // asynchronous methods. Own those methods without changing identity
          // for ordinary data returned by asynchronous calls.
          return result !== null && typeof result === 'object'
            ? this.manage(result)
            : result
        }
      },
    })
  }

  async drain(cleanup: () => unknown): Promise<void> {
    // A test body still setting up can register another parked operation after
    // teardown starts. unpark() must release such operations immediately.
    this.closing = true
    this.cancellation.abort()
    await drainBodies(
      this.releases,
      this.bodies,
      async () => {
        try {
          const results = await Promise.allSettled(
            this.finalizers
              .splice(0)
              .map((work) => Promise.resolve().then(work)),
          )
          const errors = results.flatMap((result) =>
            result.status === 'rejected' ? [result.reason] : [],
          )
          if (errors.length)
            throw new AggregateError(errors, 'Test resource finalizers failed')
        } finally {
          await cleanup()
        }
      },
      this.operations,
    )
  }
}
