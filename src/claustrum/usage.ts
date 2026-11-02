import { ClaustrumCredentialError } from '@cortexkit/claustrum-client'
import type { ClaustrumLogger } from './errors.js'

/** Reply quota metadata, never authorization headers or bearer material. */
export interface ClaustrumUsageReading {
  provider: string
  observedAtMs: number
  headers?: Record<string, string>
  frame?: unknown
  account?: string
}

/** Structural to also typecheck with the claustrum-client 0.6.2 peer minimum. */
export interface ScopedUsageSource {
  reportUsageScoped?(input: {
    credentialId: string
    reading: Record<string, unknown>
    enrollmentToken?: string
  }): Promise<void>
}

export interface ClaustrumUsageReportState {
  readonly pending: number
  readonly inFlight: boolean
  readonly dropped: number
}

function plain(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  )
}

/** One queue per custody connection, shared by every hub member on it. */
export class ScopedUsageReporter {
  readonly #queue = new Map<string, Record<string, unknown>>()
  readonly #latest = new Map<string, number>()
  readonly #errors = new Set<string>()
  #timer?: ReturnType<typeof setTimeout>
  #running?: Promise<void>
  #closing = false
  #stopped = false
  #dropped = 0

  constructor(
    private readonly options: {
      client: ScopedUsageSource
      owns: (credentialId: string) => boolean
      token: () => Promise<string>
      logger: ClaustrumLogger
      setTimeout: typeof setTimeout
      clearTimeout: typeof clearTimeout
    },
  ) {}

  state(): ClaustrumUsageReportState {
    return {
      pending: this.#queue.size,
      inFlight: this.#running !== undefined,
      dropped: this.#dropped,
    }
  }

  report(credentialId: string, reading: ClaustrumUsageReading): void {
    if (this.#closing || !this.options.client.reportUsageScoped) return
    try {
      if (!this.options.owns(credentialId)) {
        this.#dropped++
        return
      }
      if (!plain(reading) || 'credentialId' in reading || 'vouched' in reading)
        throw new Error('invalid reading')
      const json = JSON.stringify(reading)
      if (Buffer.byteLength(json, 'utf8') > 15_360)
        throw new Error('oversized reading')
      // Snapshot now: a caller mutating its reply metadata later cannot change
      // an already validated queued reading, including its ordering timestamp.
      const copy: unknown = JSON.parse(json)
      if (
        !plain(copy) ||
        'credentialId' in copy ||
        'vouched' in copy ||
        typeof copy.observedAtMs !== 'number' ||
        !Number.isFinite(copy.observedAtMs)
      )
        throw new Error('invalid reading')
      if (copy.observedAtMs <= (this.#latest.get(credentialId) ?? -Infinity)) {
        this.#dropped++
        return
      }
      if (this.#queue.has(credentialId)) this.#dropped++
      this.#latest.set(credentialId, copy.observedAtMs)
      this.#queue.set(credentialId, copy)
      if (!this.#timer && !this.#running) {
        this.#timer = this.options.setTimeout(() => {
          this.#timer = undefined
          this.#flush()
        }, 1_000)
        this.#timer.unref?.()
      }
    } catch {
      this.#dropped++
    }
  }

  forget(credentialId: string): void {
    if (this.#queue.delete(credentialId)) this.#dropped++
    this.#latest.delete(credentialId)
  }

  #flush(): Promise<void> | undefined {
    if (this.#running || !this.#queue.size || this.#stopped)
      return this.#running
    // Start on a microtask even during close, so all failures stay off the
    // provider request path and only one send can be in flight on this client.
    const running = Promise.resolve().then(async () => {
      while (!this.#stopped && this.#queue.size) {
        const entry = this.#queue.entries().next().value
        if (!entry) break
        const [credentialId, reading] = entry
        this.#queue.delete(credentialId)
        try {
          const enrollmentToken = await this.options.token()
          if (this.#stopped || !this.options.owns(credentialId)) {
            if (!this.#stopped) this.#dropped++
            continue
          }
          await this.options.client.reportUsageScoped?.({
            credentialId,
            reading,
            enrollmentToken,
          })
        } catch (error) {
          if (!this.#stopped) this.#dropped++
          this.#log(error)
        }
      }
    })
    this.#running = running
    void running.finally(() => {
      this.#running = undefined
    })
    return running
  }

  #log(error: unknown): void {
    // Only codes from credential refusals are exposed. Transport messages,
    // arbitrary thrown objects and reply contents can contain secrets.
    let code = 'transport_error'
    try {
      if (error instanceof ClaustrumCredentialError)
        code = /^[a-z][a-z0-9_]{0,63}$/.test(error.code) ? error.code : code
      if (this.#errors.has(code)) return
      this.#errors.add(code)
      this.options.logger.debug('claustrum usage report dropped', { code })
    } catch {
      // A caller's logger must not turn best-effort reporting into a rejection.
    }
  }

  /** Start the final flush; the custody's existing shutdown drain bounds it. */
  close(): Promise<void> | undefined {
    this.#closing = true
    if (this.#timer) this.options.clearTimeout(this.#timer)
    this.#timer = undefined
    return this.#flush()
  }

  drop(): void {
    this.#stopped = true
    this.#dropped += this.#queue.size + (this.#running ? 1 : 0)
    this.#running = undefined
    this.#queue.clear()
    this.#latest.clear()
  }
}
