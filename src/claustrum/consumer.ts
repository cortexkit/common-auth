import type { ClaustrumReporterSource } from '@cortexkit/claustrum-client'
import { createLogger } from '../logger/index.js'
import type { QuotaObservation } from '../quota/index.js'
import type { RoutingRow } from '../routing/index.js'
import { combineAbortSignals } from '../util/any-signal.js'
import {
  type ClaustrumFamily,
  type ClaustrumRosterWatch,
  type ClaustrumScopedAttempt,
  type ClaustrumScopedClient,
  ClaustrumScopedCustody,
  decideScopedRetryAfter401,
  type IdentityParser,
  type KeptReceiptState,
  type VaultGrantReach,
} from './custody.js'
import { readClaustrumEnrollmentToken } from './enrollment.js'
import { ClaustrumConsumerError, type ClaustrumLogger } from './errors.js'
import {
  acquireInsulaQuotaSource,
  type InsulaQuotaMiss,
  type InsulaQuotaOptions,
  type InsulaQuotaResult,
} from './insula.js'
import { pendingVaultQuota, retainVaultQuotaWriter } from './quota-writer.js'
import {
  type AccountMapper,
  acceptVaultRoute,
  applyVaultQuota,
  declineVaultRoute,
  forgetPendingVaultDiscovery,
  type QuotaReceipt,
  type ReorderVaultRosterResult,
  readVaultRoster,
  recordVaultAccountQuota,
  recordVaultQuota,
  refreshVaultRoster,
  reorderVaultRoster,
  type VaultRosterFile,
  vaultRoutingRows,
} from './roster.js'
import { SAFETY_POLL_MS, type WatchMode } from './watch.js'

export interface ClaustrumConsumerOptions<Q = QuotaObservation> {
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
   * Issue a receipt only when the vault's served reply itself names the
   * credential id and the roster's account identity (see
   * `ClaustrumScopedCustody`). Set it for providers whose tokens do not reveal
   * their account; leave it unset to accept a reply that asserts no identity.
   */
  requireAssertion?: boolean
  /**
   * Fired once per change of the vault's view cursor, including the first
   * roster. A poll that sees the same view does not fire, and neither does a
   * routine token refresh, which never moves the view.
   */
  onRoster?: (roster: VaultRosterFile) => void
  onError?: (error: unknown) => void
  /**
   * How often `start()` ticks. A tick lists the vault when no vault watch is
   * open (before it is accepted, or when the vault or the client cannot
   * watch), and otherwise only every five minutes, as a safety net. A tick
   * polls insula (at most once a minute) only while its watch is not open.
   */
  pollIntervalMs?: number
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
  now?: () => number
  logger?: ClaustrumLogger
  /** Optional background quota source. In-band readings still use recordQuota. */
  insula?: InsulaQuotaOptions<Q>
}

/**
 * How a started consumer learns about changes, for logs and status displays.
 * `insula` is present when the consumer was given an insula source. Never
 * carries secrets.
 */
export interface ClaustrumWatchState {
  readonly vault: WatchMode
  readonly insula?: WatchMode
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
export class ClaustrumConsumer<Q = QuotaObservation> {
  readonly #options: ClaustrumConsumerOptions<Q>
  readonly #shutdown = new AbortController()
  readonly #logger: ClaustrumLogger
  #custody?: ClaustrumScopedCustody
  #connecting?: Promise<ClaustrumScopedCustody>
  #refreshing?: Promise<VaultRosterFile | undefined>
  #roster?: VaultRosterFile
  /**
   * The grants named by this instance's latest discovery, with the view that
   * discovery committed. Memory only: the roster file never carries it.
   */
  #grantReach?: { readonly view: string; readonly reach: VaultGrantReach }
  #timer?: ReturnType<typeof setTimeout>
  #started = false
  #insula?: ReturnType<typeof acquireInsulaQuotaSource>
  #vaultWatch?: ClaustrumRosterWatch
  #releaseInsulaWatch?: () => void
  readonly #insulaSkips = new Map<string, InsulaQuotaMiss>()
  /** When this instance last completed a discovery, by `now`. */
  #discoveredAt?: number
  readonly #releaseQuotaWriter: () => Promise<void>

  constructor(options: ClaustrumConsumerOptions<Q>) {
    this.#options = options
    this.#logger = options.logger ?? createLogger('claustrum')
    this.#releaseQuotaWriter = retainVaultQuotaWriter(
      options.rosterPath,
      (publication) => {
        this.#roster = applyVaultQuota(this.#roster, publication).roster
      },
    )
  }

  #assertOpen(signal?: AbortSignal) {
    this.#shutdown.signal.throwIfAborted()
    signal?.throwIfAborted()
  }

  async #active(): Promise<boolean> {
    return (await this.#options.isCustodyActive?.()) ?? true
  }

  #wait<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
    const combined = combineAbortSignals([
      this.#shutdown.signal,
      ...(signal ? [signal] : []),
    ])
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        combined.signal.removeEventListener('abort', abort)
        combined.dispose()
      }
      const abort = () => {
        cleanup()
        reject(combined.signal.reason)
      }
      combined.signal.addEventListener('abort', abort, { once: true })
      // Observe the operation even after cancellation: shared metadata work may
      // finish for other callers, and a late connection must still be closed.
      pending.then(
        (value) => {
          cleanup()
          if (combined.signal.aborted) reject(combined.signal.reason)
          else resolve(value)
        },
        (error: unknown) => {
          cleanup()
          reject(error)
        },
      )
      if (combined.signal.aborted) abort()
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
            setTimeoutImpl: this.#options.setTimeoutImpl,
            clearTimeoutImpl: this.#options.clearTimeoutImpl,
          })
          if (this.#options.insula && client.insula) {
            this.#insula = acquireInsulaQuotaSource(
              client.insula,
              this.#options.tokenPath,
            )
          }
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

  /**
   * What this consumer is granted, from its latest discovery, without any I/O.
   * It explains an empty roster: `grants === 0` means no grant at all, while
   * `grants > 0` means a grant that reaches no credential (`tuples` names its
   * selector). Undefined means unknown, never zero: the vault or client is too
   * old to send it, nothing was discovered yet, or the roster now in memory is
   * a different view than the one this instance discovered (a peer process
   * held the discovery lease and its newer roster was served instead).
   */
  grantReach(): VaultGrantReach | undefined {
    const latest = this.#grantReach
    return latest && this.#roster?.view === latest.view
      ? latest.reach
      : undefined
  }

  /** How this consumer currently learns about changes, without I/O. */
  watchState(): ClaustrumWatchState {
    return Object.freeze({
      vault: this.#vaultWatch?.mode ?? 'polling',
      ...(this.#options.insula && {
        insula: this.#insula?.source.watchMode() ?? 'polling',
      }),
    })
  }

  /** Close the watches with the connection they belong to. */
  #stopWatch(): void {
    this.#vaultWatch?.close()
    this.#vaultWatch = undefined
    this.#releaseInsulaWatch?.()
    this.#releaseInsulaWatch = undefined
  }

  /** Whether any account is using an in-memory outage receipt, without I/O. */
  keptReceiptState(): KeptReceiptState {
    return (
      this.#custody?.keptReceiptState() ??
      Object.freeze({ active: false, since: null })
    )
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
        this.#grantReach = undefined
        this.#stopWatch()
        this.#custody?.close()
        this.#custody = undefined
        this.#insula?.release()
        this.#insula = undefined
        return undefined
      }
      const custody = await this.#getCustody()
      // Capture the inventory so its grant fields can be kept beside the roster;
      // the roster file itself never stores them.
      let discovered: Awaited<ReturnType<typeof custody.discover>> | undefined
      const roster = await refreshVaultRoster({
        path: this.#options.rosterPath,
        custody,
        onInventory: (inventory) => {
          discovered = inventory
        },
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
      this.#roster = pendingVaultQuota(this.#options.rosterPath, roster)
      custody.retain(roster?.rows ?? [])
      // Each discovery replaces the previous value, including with unknown. A
      // refresh that served a peer's roster discovered nothing and leaves it;
      // grantReach() hides it once the roster's view no longer matches.
      if (discovered && roster?.view !== undefined)
        this.#grantReach = discovered.grantReach
          ? { view: roster.view, reach: discovered.grantReach }
          : undefined
      // Notify on view changes only: subscribers rewrite shared state on each
      // notification, and the poll runs every few seconds.
      if (roster && changed) this.#options.onRoster?.(roster)
      this.#discoveredAt = (this.#options.now ?? Date.now)()
      return roster
    })().finally(() => {
      this.#refreshing = undefined
    })
    return this.#refreshing
  }

  /**
   * Poll in the background and open the vault and insula watches. Until the
   * vault watch is accepted, and whenever it is unavailable, every tick lists
   * the vault exactly as before watches existed. While it is open a tick
   * lists only when five minutes have passed since the last discovery, since
   * the watch keeps no history; it still checks `isCustodyActive`, so a switch
   * to local mode closes the connection as quickly as before. Insula is
   * polled on the tick only while its own watch is not open. A host not in
   * vault mode makes no request.
   */
  start(): void {
    if (this.#started) return
    this.#assertOpen()
    this.#started = true
    const tick = async () => {
      try {
        if (await this.#listDue()) await this.refresh()
        await this.refreshInsulaQuota()
        this.#openWatch()
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

  /** Whether a background tick must list the vault now. */
  async #listDue(): Promise<boolean> {
    if (this.#vaultWatch?.mode !== 'watching') return true
    const now = (this.#options.now ?? Date.now)()
    if (
      this.#discoveredAt === undefined ||
      now - this.#discoveredAt >= SAFETY_POLL_MS
    )
      return true
    // refresh() is what closes the connection when the host left vault mode.
    return !(await this.#active())
  }

  /**
   * Open the vault and insula watches once a vault connection exists. Only
   * reached in vault mode: a host in local mode never connects.
   */
  #openWatch(): void {
    const custody = this.#custody
    if (this.#shutdown.signal.aborted || !custody) return
    // The same entry point a host without a consumer uses, so both apply
    // notices, refusals and outages alike.
    this.#vaultWatch ??= custody.watchRoster({
      view: () => this.#roster?.view,
      // The existing discovery, so a watched change commits the roster and
      // re-applies it to kept receipts exactly as a poll does. A refresh
      // already in flight may have listed before the change was announced,
      // so wait for it and list again.
      onView: async () => {
        while (this.#refreshing) await this.#refreshing.catch(() => {})
        await this.refresh()
      },
      // Custody has dropped kept receipts, as a poll meeting the same
      // refusal from list_scoped would.
      onRefused: (error) => this.#options.onError?.(error),
      onError: (error) => {
        if (!this.#shutdown.signal.aborted) this.#options.onError?.(error)
      },
    })
    if (this.#options.insula && this.#insula && !this.#releaseInsulaWatch)
      this.#releaseInsulaWatch = this.#insula.source.watch({
        provider: this.#options.insula.provider,
        setTimeoutImpl: this.#options.setTimeoutImpl,
        clearTimeoutImpl: this.#options.clearTimeoutImpl,
      })
  }

  /**
   * Fetch on a background tick, at most once per minute across projects with
   * the same daemon and enrollment token path. Admission must use the cache
   * instead, so an optional quota daemon never delays a provider request.
   */
  async refreshInsulaQuota(): Promise<void> {
    if (
      !this.#options.insula ||
      this.#shutdown.signal.aborted ||
      !(await this.#active())
    )
      return
    try {
      await readClaustrumEnrollmentToken(this.#options.tokenPath)
      await this.#getCustody()
      await this.#insula?.source.refresh((this.#options.now ?? Date.now)())
    } catch {
      // An optional source must never prevent the plugin's own quota poll.
    }
  }

  /**
   * Cache-only, for unknown-quota admission with a served receipt. Undefined
   * means poll the provider normally. Only get_scoped's asserted account_id
   * joins insula; parsed identities and display metadata cannot substitute.
   * Background polling should use cachedInsulaQuotaForRoute instead.
   */
  async cachedInsulaQuota(
    receipt: Pick<ClaustrumScopedAttempt, 'assertedAccountIdentity'>,
  ): Promise<Q | undefined> {
    if (
      !this.#options.insula ||
      this.#shutdown.signal.aborted ||
      !(await this.#active())
    )
      return undefined
    try {
      await readClaustrumEnrollmentToken(this.#options.tokenPath)
      return this.#normalizeInsulaQuota(receipt.assertedAccountIdentity)
    } catch {
      return undefined
    }
  }

  /**
   * Background cache lookup without fetching a credential. Re-read the roster
   * so a peer's account replacement invalidates the old route immediately.
   * A route without a known provider account cannot join an insula entry.
   */
  async cachedInsulaQuotaForRoute(routeId: string): Promise<Q | undefined> {
    if (
      !this.#options.insula ||
      this.#shutdown.signal.aborted ||
      !(await this.#active())
    )
      return undefined
    try {
      await readClaustrumEnrollmentToken(this.#options.tokenPath)
      const roster = pendingVaultQuota(
        this.#options.rosterPath,
        await readVaultRoster(this.#options.rosterPath),
      )
      const row = roster?.rows.find((entry) => entry.routeId === routeId)
      return this.#normalizeInsulaQuota(row?.accountIdentity)
    } catch {
      return undefined
    }
  }

  /** Cache-only background lookup, preserving the reason a route has no reading. */
  async lookupInsulaQuotaForRoute(
    routeId: string,
  ): Promise<InsulaQuotaResult<Q>> {
    const options = this.#options.insula
    if (!options || this.#shutdown.signal.aborted || !(await this.#active()))
      return { miss: 'unreachable' }
    try {
      await readClaustrumEnrollmentToken(this.#options.tokenPath)
      const roster = pendingVaultQuota(
        this.#options.rosterPath,
        await readVaultRoster(this.#options.rosterPath),
      )
      const account = roster?.rows.find(
        (row) => row.routeId === routeId,
      )?.accountIdentity
      if (!account || !this.#insula) return { miss: 'unreachable' }
      const result = this.#insula.source.lookup(
        options.provider,
        account,
        (this.#options.now ?? Date.now)(),
      )
      const reading =
        result.reading &&
        options.normalize(result.reading.entry, result.reading.context)
      if (result.miss)
        return { miss: result.miss, ...(reading !== undefined && { reading }) }
      // Refusing an echo or unsupported window leaves the plugin's poll in charge.
      return reading === undefined ? { miss: 'unreachable' } : { reading }
    } catch {
      return { miss: 'unreachable' }
    }
  }

  /** Skip the fallback poll while insula is cold or its upstream fetch failed. */
  async pollInsulaQuotaForRoute(
    routeId: string,
    fallback: () => Promise<Q | undefined>,
  ): Promise<Q | undefined> {
    const result = await this.lookupInsulaQuotaForRoute(routeId)
    if (result.miss === 'cold' || result.miss === 'upstream-failed') {
      if (this.#insulaSkips.get(routeId) !== result.miss) {
        this.#insulaSkips.set(routeId, result.miss)
        this.#logger.warn('skipped insula provider poll', {
          reason: result.miss,
        })
      }
      return undefined
    }
    this.#insulaSkips.delete(routeId)
    return result.miss ? fallback() : result.reading
  }

  #normalizeInsulaQuota(accountIdentity: string | undefined): Q | undefined {
    if (!this.#options.insula || !accountIdentity) return undefined
    const current = this.#insula?.source.current(
      this.#options.insula.provider,
      accountIdentity,
      (this.#options.now ?? Date.now)(),
    )
    return current
      ? this.#options.insula.normalize(current.entry, current.context)
      : undefined
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
    if (!roster || !(await this.#active())) {
      this.#custody?.close()
      this.#custody = undefined
      this.#stopWatch()
      this.#insula?.release()
      this.#insula = undefined
      throw new ClaustrumConsumerError(
        'not-active',
        'Claustrum scoped custody is not active',
      )
    }
    const current = pendingVaultQuota(
      this.#options.rosterPath,
      await readVaultRoster(this.#options.rosterPath),
    )
    this.#assertOpen(signal)
    const observed = roster.rows.find((row) => row.routeId === routeId)
    const configured = current?.rows.find((row) => row.routeId === routeId)
    if (configured && !configured.enabled) {
      if (observed) this.#custody?.forget(observed.credentialId)
      throw new ClaustrumConsumerError(
        'route-declined',
        'Claustrum route is disabled',
      )
    }
    if (
      !observed ||
      !configured ||
      configured.state !== 'active' ||
      configured.credentialId !== observed.credentialId ||
      configured.accountIdentity !== observed.accountIdentity ||
      configured.credentialType !== observed.credentialType
    ) {
      if (observed) this.#custody?.forget(observed.credentialId)
      throw new ClaustrumConsumerError(
        'route-unavailable',
        'Claustrum route is disabled, removed or changed',
      )
    }
    const custody = await this.#wait(this.#getCustody(), signal)
    const combined = combineAbortSignals([
      this.#shutdown.signal,
      ...(signal ? [signal] : []),
    ])
    try {
      return await custody.authorize(
        {
          credentialId: configured.credentialId,
          credentialType: configured.credentialType,
          ...(configured.accountIdentity !== undefined && {
            accountIdentity: configured.accountIdentity,
          }),
        },
        combined.signal,
        routeId,
      )
    } finally {
      combined.dispose()
    }
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
    if (response.status === 401 && served.fromKeptReceipt) {
      await this.reportFailure(served, 401, options.reporterSource ?? 'direct')
      return response
    }
    if (response.status === 401 && !signal?.aborted) {
      let current: ClaustrumScopedAttempt | undefined
      try {
        current = await this.authorize(routeId, signal)
        // Cancellation can land after authorize settles, before this continuation.
        signal?.throwIfAborted()
      } catch (error) {
        if (signal?.aborted) throw error
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
    this.#roster = pendingVaultQuota(
      this.#options.rosterPath,
      await readVaultRoster(this.#options.rosterPath),
    )
    this.#custody?.retain(this.#roster?.rows ?? [])
  }

  async accept(routeId: string): Promise<void> {
    this.#assertOpen()
    await acceptVaultRoute(this.#options.rosterPath, routeId)
    this.#roster = pendingVaultQuota(
      this.#options.rosterPath,
      await readVaultRoster(this.#options.rosterPath),
    )
  }

  /**
   * Set the order vault accounts are tried in (`reorderVaultRoster`), then
   * re-read the roster, so the next routing decision in this process uses
   * the new order without waiting for a discovery. Never contacts the vault.
   */
  async reorder(
    routeIds: readonly string[],
  ): Promise<ReorderVaultRosterResult> {
    this.#assertOpen()
    const result = await reorderVaultRoster(this.#options.rosterPath, routeIds)
    this.#roster = pendingVaultQuota(
      this.#options.rosterPath,
      await readVaultRoster(this.#options.rosterPath),
    )
    return result
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
    return recordVaultQuota(this.#options.rosterPath, {
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
  }

  /**
   * Store a background observation that belongs to an account rather than to
   * a served credential (an insula reading from `cachedInsulaQuotaForRoute`).
   * It lands only while the route is still bound to that known account, so no
   * credential fetch is needed and a replaced account's reading is dropped.
   * Memory updates immediately; durable publication is detached and coalesced.
   */
  async recordAccountQuota(
    routeId: string,
    accountIdentity: string,
    observation: QuotaObservation,
  ): Promise<boolean> {
    this.#assertOpen()
    return recordVaultAccountQuota(this.#options.rosterPath, {
      routeId,
      accountIdentity,
      observation,
    })
  }

  close(): void {
    if (this.#shutdown.signal.aborted) return
    this.#shutdown.abort(
      new ClaustrumConsumerError('closed', 'Claustrum consumer is closed'),
    )
    if (this.#timer)
      (this.#options.clearTimeoutImpl ?? clearTimeout)(this.#timer)
    this.#timer = undefined
    this.#stopWatch()
    this.#custody?.close()
    this.#insula?.release()
    this.#insula = undefined
    this.#roster = undefined
    this.#grantReach = undefined
    void this.#releaseQuotaWriter()
    forgetPendingVaultDiscovery(this.#options.rosterPath)
  }

  /** Close immediately; the last consumer also waits for the writer's bounded drain. */
  async dispose(): Promise<void> {
    this.close()
    await this.#releaseQuotaWriter()
  }
}
