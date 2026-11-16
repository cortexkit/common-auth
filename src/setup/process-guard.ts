/** Reuse an inspection only while setup has done nothing a running host could observe. */
export class SetupProcessGuard {
  #checkedAt: number | undefined

  constructor(
    private readonly inspect: () => Promise<void>,
    private readonly now: () => number = () => performance.now(),
  ) {}

  async check(options: { reuse?: boolean } = {}): Promise<void> {
    if (options.reuse && this.#checkedAt !== undefined) {
      const age = this.now() - this.#checkedAt
      // Slow read-only RPCs must not extend an inspection indefinitely.
      if (age >= 0 && age < 5000) return
    }
    this.#checkedAt = undefined
    await this.inspect()
    this.#checkedAt = this.now()
  }

  /** Callbacks, writes and waits can all make an earlier inspection stale. */
  async step<T>(run: () => T | Promise<T>): Promise<T> {
    this.#checkedAt = undefined
    try {
      return await run()
    } finally {
      // A nested token-write check must not escape its enclosing reconcile.
      this.#checkedAt = undefined
    }
  }
}
