import type { ClaustrumReporterSource } from '@cortexkit/claustrum-client'
import { createLogger } from '../logger/index.js'
import type { QuotaObservation } from '../quota/index.js'
import type { RoutingRow } from '../routing/index.js'
import {
  type ClaustrumFamily,
  type ClaustrumScopedAttempt,
  type ClaustrumScopedClient,
  ClaustrumScopedCustody,
  decideScopedRetryAfter401,
  type IdentityParser,
} from './custody.js'
import { ClaustrumConsumerError, type ClaustrumLogger } from './errors.js'
import {
  type AccountMapper,
  acceptVaultRoute,
  declineVaultRoute,
  type QuotaReceipt,
  readVaultRoster,
  recordVaultQuota,
  refreshVaultRoster,
  type VaultRosterFile,
  vaultRoutingRows,
} from './roster.js'

export interface ClaustrumConsumerOptions {
  /**
   * The roster file: one row per vault account (route id, credential id,
   * account identity, state, quota), plus the accounts the user declined. It
   * never holds a token.
   */
  rosterPath: string
  /** This host's enrollment token, written by setup. */
  tokenPath: string
  family: ClaustrumFamily
  connect: () => Promise<ClaustrumScopedClient>
  /**
   * Whether the plugin currently takes its accounts from the vault (custody
   * mode) rather than from local logins. Checked before every discovery,
   * commit and dispatch; false closes the vault connection and refuses sends.
   */
  isCustodyActive?: () => boolean | Promise<boolean>
  /** Ids of the plugin's local pool rows; no vault route id may equal one. */
  reservedRouteIds?: () => Iterable<string>
  routePrefix?: string
  mapAccount?: AccountMapper
  parseIdentity?: IdentityParser
  /**
   * Issue a receipt only when the vault's served reply names the credential id
   * and the roster's account identity itself (see `ClaustrumScopedCustody`).
   * For providers whose tokens are opaque; leave unset to accept a reply that
   * asserts no identity.
   */
  requireAssertion?: boolean
  /**
   * Fired once per change of the vault's view cursor, including the first
   * roster. A poll that sees the same view does not fire, and neither does a
   * routine token refresh, which never moves the view.
   */
  onRoster?: (roster: VaultRosterFile) => void
  onError?: (error: unknown) => void
  pollIntervalMs?: number
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
  now?: () => number
  logger?: ClaustrumLogger
}

export interface SendOptions {
  /**
   * What kind of request this is (for example `model`, `quota`, `profile`),
   * recorded in the 401 retry log line so a retry can be traced to its caller.
   */
  site: string
  signal?: AbortSignal
  reporterSource?: ClaustrumReporterSource
}

/**
 * One plugin host's view of its vault accounts. It turns vault credentials
 * into rows for `/routing`, authorizes each physical send with the vault, and
 * reports a 401 against the exact record version that send used. Metadata
 * (the connection and discovery) is shared and coalesced; credential reads
 * never are. It never enrolls: a missing token is an error here, and setup
 * is where enrollment happens.
 */
export class ClaustrumConsumer {
  readonly #options: ClaustrumConsumerOptions
  readonly #shutdown = new AbortController()
  readonly #logger: ClaustrumLogger
  #custody?: ClaustrumScopedCustody
  #connecting?: Promise<ClaustrumScopedCustody>
  #refreshing?: Promise<VaultRosterFile | undefined>
  #roster?: VaultRosterFile
  #timer?: ReturnType<typeof setTimeout>
  #started = false

  constructor(options: ClaustrumConsumerOptions) {
    this.#options = options
    this.#logger = options.logger ?? createLogger('claustrum')
  }

  #assertOpen(signal?: AbortSignal) {
    this.#shutdown.signal.throwIfAborted()
    signal?.throwIfAborted()
  }

  async #active(): Promise<boolean> {
    return (await this.#options.isCustodyActive?.()) ?? true
  }

  #wait<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
    const combined = AbortSignal.any([
      this.#shutdown.signal,
      ...(signal ? [signal] : []),
    ])
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => combined.removeEventListener('abort', abort)
      const abort = () => {
        cleanup()
        reject(combined.reason)
      }
      combined.addEventListener('abort', abort, { once: true })
      // Observe the operation even after cancellation: shared metadata work may
      // finish for other callers, and a late connection must still be closed.
      pending.then(
        (value) => {
          cleanup()
          if (combined.aborted) reject(combined.reason)
          else resolve(value)
        },
        (error: unknown) => {
          cleanup()
          reject(error)
        },
      )
      if (combined.aborted) abort()
    })
  }

  async #getCustody(): Promise<ClaustrumScopedCustody> {
    this.#assertOpen()
    if (this.#custody) return this.#custody
    if (!this.#connecting) {
      this.#connecting = this.#options
        .connect()
        .then((client) => {
          if (this.#shutdown.signal.aborted) {
            client.close()
            this.#assertOpen()
          }
          this.#custody = new ClaustrumScopedCustody({
            client,
            family: this.#options.family,
            tokenPath: this.#options.tokenPath,
            parseIdentity: this.#options.parseIdentity,
            requireAssertion: this.#options.requireAssertion,
            now: this.#options.now,
            logger: this.#logger,
          })
          return this.#custody
        })
        .finally(() => {
          this.#connecting = undefined
        })
    }
    return this.#wait(this.#connecting)
  }

  /** The last committed roster this instance saw, without any I/O. */
  snapshot(): VaultRosterFile | undefined {
    return this.#roster
  }

  /** Rows for `/routing`, from the last committed roster. */
  routingRows(): RoutingRow[] {
    return vaultRoutingRows(this.#roster)
  }

  refresh(): Promise<VaultRosterFile | undefined> {
    this.#assertOpen()
    if (this.#refreshing) return this.#refreshing
    this.#refreshing = (async () => {
      if (!(await this.#active())) {
        this.#roster = undefined
        this.#custody?.close()
        this.#custody = undefined
        return undefined
      }
      const custody = await this.#getCustody()
      const roster = await refreshVaultRoster({
        path: this.#options.rosterPath,
        custody,
        isActive: () => this.#active(),
        signal: this.#shutdown.signal,
        projection: () => ({
          reservedRouteIds: new Set(this.#options.reservedRouteIds?.() ?? []),
          routePrefix: this.#options.routePrefix,
          mapAccount: this.#options.mapAccount,
          now: (this.#options.now ?? Date.now)(),
        }),
      })
      this.#assertOpen()
      const changed = roster?.view !== this.#roster?.view
      this.#roster = roster
      // Notify on view changes only: subscribers rewrite shared state on each
      // notification, and the poll runs every few seconds.
      if (roster && changed) this.#options.onRoster?.(roster)
      return roster
    })().finally(() => {
      this.#refreshing = undefined
    })
    return this.#refreshing
  }

  start(): void {
    if (this.#started) return
    this.#assertOpen()
    this.#started = true
    const tick = async () => {
      try {
        await this.refresh()
      } catch (error) {
        if (!this.#shutdown.signal.aborted) this.#options.onError?.(error)
      }
      if (this.#shutdown.signal.aborted) return
      const delay = this.#options.pollIntervalMs ?? 5_000
      if (delay <= 0) return
      this.#timer = (this.#options.setTimeoutImpl ?? setTimeout)(() => {
        this.#timer = undefined
        void tick()
      }, delay)
      this.#timer.unref?.()
    }
    void tick()
  }

  /**
   * Authorize one physical send on a vault route. The roster file is re-read
   * first, so a decline committed by another process applies before the next
   * poll, and a route whose credential or account changed is refused.
   */
  async authorize(
    routeId: string,
    signal?: AbortSignal,
  ): Promise<ClaustrumScopedAttempt> {
    this.#assertOpen(signal)
    const roster = this.#roster ?? (await this.#wait(this.refresh(), signal))
    if (!roster || !(await this.#active()))
      throw new ClaustrumConsumerError(
        'not-active',
        'Claustrum scoped custody is not active',
      )
    const current = await readVaultRoster(this.#options.rosterPath)
    this.#assertOpen(signal)
    const observed = roster.rows.find((row) => row.routeId === routeId)
    const configured = current?.rows.find((row) => row.routeId === routeId)
    if (configured && !configured.enabled)
      throw new ClaustrumConsumerError(
        'route-declined',
        'Claustrum route is disabled',
      )
    if (
      !observed ||
      !configured ||
      configured.state !== 'active' ||
      configured.credentialId !== observed.credentialId ||
      configured.accountIdentity !== observed.accountIdentity
    )
      throw new ClaustrumConsumerError(
        'route-unavailable',
        'Claustrum route is disabled, removed or changed',
      )
    return (await this.#wait(this.#getCustody(), signal)).authorize(
      {
        credentialId: configured.credentialId,
        credentialType: configured.credentialType,
        ...(configured.accountIdentity !== undefined && {
          accountIdentity: configured.accountIdentity,
        }),
      },
      AbortSignal.any([this.#shutdown.signal, ...(signal ? [signal] : [])]),
    )
  }

  async reportFailure(
    attempt: ClaustrumScopedAttempt,
    status: number,
    source: ClaustrumReporterSource,
  ): Promise<void> {
    this.#assertOpen()
    if (!this.#custody)
      throw new ClaustrumConsumerError(
        'no-receipt',
        'Claustrum dispatch receipt has no active owner',
      )
    await this.#custody.reportFailure(attempt, status, source)
  }

  /**
   * Send on a vault route. `dispatch` builds and sends the request with the
   * receipt's token and may be called twice, so it must be able to rebuild
   * its body. A 401 is retried once, and only when the vault now serves a new
   * record version of the same credential and account; the final 401 is
   * reported against the version that send actually used. Each call to
   * `dispatch` gets its own receipt.
   */
  async send(
    routeId: string,
    dispatch: (
      attempt: ClaustrumScopedAttempt,
      signal?: AbortSignal,
    ) => Promise<Response>,
    options: SendOptions,
  ): Promise<Response> {
    const signal = options.signal
    let served = await this.authorize(routeId, signal)
    let response = await dispatch(served, signal)
    if (response.status === 401 && !signal?.aborted) {
      let current: ClaustrumScopedAttempt | undefined
      try {
        current = await this.authorize(routeId, signal)
      } catch {
        // Re-authorization failed: keep this 401 and report it against the
        // receipt (served record version) this request was sent with.
      }
      if (
        decideScopedRetryAfter401(options.site, served, current, this.#logger)
      ) {
        await response.body?.cancel().catch(() => {})
        served = current
        response = await dispatch(current, signal)
      }
    }
    if (response.status === 401) {
      await this.reportFailure(
        served,
        401,
        options.reporterSource ?? 'direct',
      ).catch((error: unknown) => this.#options.onError?.(error))
      // After the report the vault may mark the account as needing a new
      // login; refresh now so routing drops it without waiting for the next poll. Deferred so a consumer closed in
      // the meantime reports to onError instead of throwing from this send.
      Promise.resolve()
        .then(() => this.refresh())
        .catch((error: unknown) => {
          if (!this.#shutdown.signal.aborted) this.#options.onError?.(error)
        })
    }
    return response
  }

  /** Decline a vault account: it stays listed and never routes until accepted. */
  async decline(routeId: string): Promise<void> {
    this.#assertOpen()
    await declineVaultRoute(this.#options.rosterPath, routeId)
    this.#roster = await readVaultRoster(this.#options.rosterPath)
  }

  async accept(routeId: string): Promise<void> {
    this.#assertOpen()
    await acceptVaultRoute(this.#options.rosterPath, routeId)
    this.#roster = await readVaultRoster(this.#options.rosterPath)
  }

  /**
   * Store a quota or profile observation for a vault route. The receipt the
   * reading was taken with is required: the observation lands only while the
   * route still holds the credential and account that receipt was served for
   * (see `recordVaultQuota`), so a reading for a replaced account is dropped.
   */
  async recordQuota(
    routeId: string,
    observation: QuotaObservation,
    attempt: QuotaReceipt,
  ): Promise<boolean> {
    this.#assertOpen()
    const kept = await recordVaultQuota(this.#options.rosterPath, {
      routeId,
      observation,
      credentialId: attempt.credentialId,
      accountIdentitySource: attempt.accountIdentitySource,
      ...(attempt.accountIdentity !== undefined && {
        accountIdentity: attempt.accountIdentity,
      }),
      ...(attempt.expectedAccountIdentity !== undefined && {
        expectedAccountIdentity: attempt.expectedAccountIdentity,
      }),
    })
    if (kept) this.#roster = await readVaultRoster(this.#options.rosterPath)
    return kept
  }

  close(): void {
    if (this.#shutdown.signal.aborted) return
    this.#shutdown.abort(
      new ClaustrumConsumerError('closed', 'Claustrum consumer is closed'),
    )
    if (this.#timer)
      (this.#options.clearTimeoutImpl ?? clearTimeout)(this.#timer)
    this.#timer = undefined
    this.#custody?.close()
    this.#roster = undefined
  }
}
