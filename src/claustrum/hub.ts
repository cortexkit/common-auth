// One vault connection, one watch and one list for every provider a plugin
// serves on a host. The plugin still runs one ClaustrumConsumer per provider,
// each with its own roster file; the hub builds those consumers as its
// members, lists once, commits each member's share of the listing to that
// member's roster and pushes it into the member's memory.
import { join } from 'node:path'
import { createLogger } from '../logger/index.js'
import type { QuotaObservation } from '../quota/index.js'
import { combineAbortSignals } from '../util/any-signal.js'
import {
  type ClaustrumConsumer,
  type ClaustrumConsumerOptions,
  createHubMember,
  type HubMemberHooks,
  type HubMemberPort,
  type HubRefreshOutcome,
} from './consumer.js'
import {
  type ClassifyingClaustrumFamily,
  type ClaustrumRosterWatch,
  type ClaustrumScopedClient,
  ClaustrumScopedCustody,
  type IdentityParser,
  type KeptReceiptState,
  type VaultGrantReach,
  type VaultInventory,
} from './custody.js'
import { ClaustrumConsumerError, type ClaustrumLogger } from './errors.js'
import {
  type AccountMapper,
  decodedVaultRoster,
  forgetPendingVaultDiscovery,
  readVaultRoster,
  refreshVaultRoster,
  type VaultRosterFile,
} from './roster.js'
import { SAFETY_POLL_MS, type WatchMode } from './watch.js'

export interface ClaustrumDiscoveryHubOptions {
  /**
   * The plugin's owner-only state directory. Member rosters live under
   * `<stateDir>/rosters/<hostGeneration>/<provider>.json`.
   */
  stateDir: string
  /**
   * Which host generation this process runs (for example `opencode1`,
   * `opencode2` or `pi`). Hosts that classify rows differently keep separate
   * roster directories.
   */
  hostGeneration: string
  /**
   * Every provider the plugin serves on this host, fixed for the hub's life.
   * Each is the `member` a classified row names and a roster file name, so
   * it is lowercase ASCII: letters, digits, `.`, `_` and `-`.
   */
  members: readonly string[]
  /** This host's enrollment token, written by setup. */
  tokenPath: string
  /**
   * The plugin's classifying family. A legacy `ClaustrumFamily` names no
   * member for any row and is refused.
   */
  family: ClassifyingClaustrumFamily<string>
  connect: () => Promise<ClaustrumScopedClient>
  /**
   * Whether the plugin takes its accounts from the vault. Read from local
   * state only, never from the vault: on every hub tick, and when a member
   * refreshes or authorizes. The first false read revokes every lease,
   * closes the connection and clears every member.
   */
  isCustodyActive?: () => boolean | Promise<boolean>
  parseIdentity?: IdentityParser
  /** As `ClaustrumConsumerOptions.requireAssertion`, for every member. */
  requireAssertion?: boolean
  /**
   * How often the hub ticks (default 5 s). A tick reads authority, installs
   * member roster files changed under the same view, and lists when a list
   * is due: on every tick while no vault watch is open, otherwise every
   * five minutes as a safety net.
   */
  pollIntervalMs?: number
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
  now?: () => number
  logger?: ClaustrumLogger
  /** Errors of the hub's own tick, list and watch. */
  onError?: (error: unknown) => void
}

/**
 * What one hub member takes: only what is per provider. The hub owns the
 * roster path, the enrollment token, the family, the connection, the
 * authority check and the poll timer, so none of them can be given here.
 * The type parameter matches the consumer `member` returns; members have no
 * insula source.
 */
export interface ClaustrumHubMemberOptions<_Q = QuotaObservation> {
  /** Ids of the plugin's local pool rows; no vault route id may equal one. */
  reservedRouteIds?: () => Iterable<string>
  routePrefix?: string
  mapAccount?: AccountMapper
  /** As `ClaustrumConsumerOptions.onRoster`: once per change of view. */
  onRoster?: (roster: VaultRosterFile) => void
  /** This member's own failures, such as a roster commit that failed. */
  onError?: (error: unknown) => void
  logger?: ClaustrumLogger
}

/** What a lease may do with the shared custody. */
export type ClaustrumLeasedCustody = Pick<
  ClaustrumScopedCustody,
  'authorize' | 'reportFailure' | 'forget' | 'keptReceiptState'
>

/**
 * One acquisition of the hub's shared custody. `custody` throws `closed`
 * after `release()`, and once the connection it belongs to ended for any
 * reason, vault mode going off included. `release()` is idempotent.
 */
export interface CustodyLease {
  readonly custody: ClaustrumLeasedCustody
  /** The connection this lease belongs to; each new connection counts up. */
  readonly generation: number
  release(): void
}

/** The rows the hub's last complete discovery refused or left to others. */
export interface ClaustrumHubRefusals {
  readonly view: string
  readonly refused: readonly { credentialId?: string; code: string }[]
  readonly notMine: number
}

/**
 * One vault connection: one client and the one custody built on it. `count`
 * holds the leases taken on it plus the acquirers still waiting for it.
 */
interface Generation {
  readonly id: number
  count: number
  ended: boolean
  /** Aborted when the generation ends, so work started in it stops. */
  readonly controller: AbortController
  custody?: ClaustrumScopedCustody
}

interface LeaseState {
  readonly generation: Generation
  readonly custody: ClaustrumScopedCustody
  released: boolean
}

interface MemberEntry {
  readonly provider: string
  readonly path: string
  hooks?: HubMemberHooks
  closed: boolean
  /** The file content the hub last committed or installed, as JSON text. */
  seen?: string
}

/** The last discovery every member committed, and its view. */
interface Committed {
  readonly view: string
  readonly reach?: VaultGrantReach
  readonly refused: readonly { credentialId?: string; code: string }[]
  readonly notMine: number
}

interface Run {
  /** Known once the run holds the hub's own lease. */
  generation?: Generation
  readonly promise: Promise<HubRefreshOutcome | undefined>
}

/** Lowercase ASCII, safe as a file name on every OS. */
const FILE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
/** Device names Windows reserves in every directory, with any extension. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/

function fileId(value: unknown, what: string): string {
  if (
    typeof value !== 'string' ||
    !FILE_ID.test(value) ||
    WINDOWS_DEVICE.test(value)
  )
    throw new ClaustrumConsumerError(
      'invalid-state',
      `Claustrum hub ${what} must be a lowercase file-safe id`,
    )
  return value
}

function closed(message = 'Claustrum custody lease is closed') {
  return new ClaustrumConsumerError('closed', message)
}

function notActive() {
  return new ClaustrumConsumerError(
    'not-active',
    'Claustrum scoped custody is not active',
  )
}

/**
 * Follow `pending`, but reject as soon as `signal` aborts. `pending` is
 * still observed afterwards, so its rejection is never unhandled.
 */
function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    pending.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
    if (signal.aborted) abort()
  })
}

/** Which rows of a roster route, so a change of them can be retained. */
function enabledRows(roster: VaultRosterFile | undefined): string {
  return JSON.stringify(
    (roster?.rows ?? []).map((row) => [row.credentialId, row.enabled]),
  )
}

/**
 * One discovery hub per host process: the only vault connection and the only
 * `ClaustrumScopedCustody`, one vault watch and one list per refresh, fanned
 * out to one roster per provider. Members (`member()`) are ordinary
 * `ClaustrumConsumer`s that never connect, list or watch themselves; each
 * holds a custody lease. The connection stays open while vault mode is on,
 * because the hub's own discovery holds a lease of its own, and closes when
 * the last lease of a connection is released, when vault mode goes off, or
 * at `close()`.
 */
export class ClaustrumDiscoveryHub {
  readonly #options: ClaustrumDiscoveryHubOptions
  readonly #logger: ClaustrumLogger
  readonly #shutdown = new AbortController()
  readonly #members = new Map<string, MemberEntry>()
  readonly #leases = new WeakMap<CustodyLease, LeaseState>()
  #generations = 0
  #current?: Generation
  /** The pending connect, with the generation it was started for. */
  #connecting?: {
    readonly generation: Generation
    readonly promise: Promise<ClaustrumScopedCustody>
  }
  /** The lease the hub's own discovery and watch hold. */
  #own?: CustodyLease
  #watch?: {
    readonly generation: Generation
    readonly watch: ClaustrumRosterWatch
  }
  #run?: Run
  /** The hub's last authority read; undefined before the first one. */
  #active?: boolean
  /** Counts inactive transitions, so local work started before one stops. */
  #epoch = 0
  #committed?: Committed
  #discoveredAt?: number
  #timer?: ReturnType<typeof setTimeout>
  #started = false

  constructor(options: ClaustrumDiscoveryHubOptions) {
    if (!options.family || !('classify' in options.family))
      throw new ClaustrumConsumerError(
        'wrong-consumer',
        'Claustrum discovery hub requires a classifying family',
      )
    const key = fileId(options.hostGeneration, 'host generation')
    this.#options = options
    this.#logger = options.logger ?? createLogger('claustrum')
    // The roster key: one directory per host generation. Every member keeps
    // the path it is given here for its whole life.
    const directory = join(options.stateDir, 'rosters', key)
    for (const member of options.members) {
      const provider = fileId(member, 'member')
      if (this.#members.has(provider))
        throw new ClaustrumConsumerError(
          'invalid-state',
          'Claustrum hub members must be distinct',
        )
      this.#members.set(provider, {
        provider,
        path: join(directory, `${provider}.json`),
        closed: false,
      })
    }
  }

  #assertOpen(): void {
    if (this.#shutdown.signal.aborted)
      throw closed('Claustrum discovery hub is closed')
  }

  #entry(provider: string): MemberEntry {
    const entry = this.#members.get(provider)
    if (!entry)
      throw new ClaustrumConsumerError(
        'wrong-consumer',
        'Claustrum hub has no such member',
      )
    return entry
  }

  /** The roster file member `provider` reads and the hub commits. */
  rosterPath(provider: string): string {
    return this.#entry(provider).path
  }

  /**
   * Build the consumer for `provider`, once. It is an ordinary
   * `ClaustrumConsumer` whose roster path is `rosterPath(provider)`; it
   * connects, lists and watches only through this hub.
   */
  member<Q = QuotaObservation>(
    provider: string,
    options: ClaustrumHubMemberOptions<Q>,
  ): ClaustrumConsumer<Q> {
    this.#assertOpen()
    const entry = this.#entry(provider)
    if (entry.hooks)
      throw new ClaustrumConsumerError(
        'wrong-consumer',
        'Claustrum hub member was already built',
      )
    // The type has none of these; refuse them when they arrive through a cast
    // rather than let a member read a path or source the hub does not own.
    for (const owned of [
      'rosterPath',
      'tokenPath',
      'family',
      'connect',
      'isCustodyActive',
      'insula',
      'pollIntervalMs',
    ])
      if (owned in options)
        throw new ClaustrumConsumerError(
          'wrong-consumer',
          `Claustrum hub members cannot take ${owned}`,
        )
    const port: HubMemberPort = {
      provider: entry.provider,
      start: () => this.start(),
      refresh: () => this.#refresh(),
      readAuthority: () => this.#readAuthority(),
      acquire: (signal) => this.acquire(signal),
      leaseLive: (lease) => this.#leaseLive(lease),
      grantReach: (view) =>
        view !== undefined && this.#committed?.view === view
          ? this.#committed.reach
          : undefined,
      watchMode: () => this.watchState(),
      keptReceiptState: () => this.keptReceiptState(),
      retainUnion: () => this.#retainUnion(),
      forget: (credentialId) => this.#current?.custody?.forget(credentialId),
      detach: () => {
        entry.closed = true
      },
    }
    const consumerOptions = {
      rosterPath: entry.path,
      ...(options.reservedRouteIds && {
        reservedRouteIds: options.reservedRouteIds,
      }),
      ...(options.routePrefix !== undefined && {
        routePrefix: options.routePrefix,
      }),
      ...(options.mapAccount && { mapAccount: options.mapAccount }),
      ...(options.onRoster && { onRoster: options.onRoster }),
      ...(options.onError && { onError: options.onError }),
      logger: options.logger ?? this.#logger,
      ...(this.#options.now && { now: this.#options.now }),
    } as ClaustrumConsumerOptions<Q>
    const { consumer, hooks } = createHubMember<Q>(port, consumerOptions)
    entry.hooks = hooks
    return consumer
  }

  // --- leases ---

  #startGeneration(): Generation {
    const generation: Generation = {
      id: ++this.#generations,
      count: 0,
      ended: false,
      controller: new AbortController(),
    }
    this.#current = generation
    return generation
  }

  #live(generation: Generation): boolean {
    return (
      !generation.ended &&
      this.#current === generation &&
      !this.#shutdown.signal.aborted
    )
  }

  #leaseLive(lease: CustodyLease): boolean {
    const state = this.#leases.get(lease)
    return !!state && !state.released && !state.generation.ended
  }

  /**
   * End a generation: its signal aborts, every lease of it is revoked, its
   * watch stops and its custody closes (with every kept receipt and the
   * client). A connect still pending closes its own client when it resolves.
   */
  #end(generation: Generation, reason: unknown = closed()): void {
    if (generation.ended) return
    generation.ended = true
    generation.count = 0
    if (this.#current === generation) this.#current = undefined
    if (this.#own && this.#leases.get(this.#own)?.generation === generation)
      this.#own = undefined
    if (this.#watch?.generation === generation) {
      this.#watch.watch.close()
      this.#watch = undefined
    }
    generation.controller.abort(reason)
    generation.custody?.close()
  }

  /** Return one waiting acquirer's count to a generation that still runs. */
  #giveBack(generation: Generation): void {
    if (generation.ended) return
    generation.count--
    if (generation.count <= 0) this.#end(generation)
  }

  #connect(generation: Generation): Promise<ClaustrumScopedCustody> {
    const pending = this.#connecting
    if (pending?.generation === generation) return pending.promise
    const entry = {
      generation,
      promise: this.#options.connect().then((client) => {
        // A connect resolves into its generation only while that generation
        // is current and still wanted; otherwise its client never serves.
        if (!this.#live(generation) || generation.count <= 0) {
          client.close()
          throw closed('Claustrum connection is no longer wanted')
        }
        generation.custody = new ClaustrumScopedCustody({
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
        return generation.custody
      }),
    }
    // Clear only this connect: an older generation's connect settling late
    // must leave a newer generation's pending connect in place.
    const settled = entry.promise.finally(() => {
      if (this.#connecting === entry) this.#connecting = undefined
    })
    settled.catch(() => {})
    this.#connecting = entry
    return entry.promise
  }

  /**
   * Take a lease on the current connection, connecting first when there is
   * none. The acquirer's count is taken before anything is awaited, so a
   * release elsewhere meanwhile cannot end the connection under it. An abort
   * or a failed connect gives that count back; an acquirer whose connection
   * ended while it waited tries once more on the current one. Rejects with
   * `not-active` while vault mode is off.
   */
  acquire(signal?: AbortSignal): Promise<CustodyLease> {
    try {
      this.#assertOpen()
      signal?.throwIfAborted()
      if (this.#active === false) throw notActive()
    } catch (error) {
      return Promise.reject(error)
    }
    const generation = this.#current ?? this.#startGeneration()
    generation.count++
    return this.#settle(generation, signal, true)
  }

  async #settle(
    generation: Generation,
    signal: AbortSignal | undefined,
    retry: boolean,
  ): Promise<CustodyLease> {
    let custody = generation.custody
    if (!custody) {
      const combined = combineAbortSignals([
        generation.controller.signal,
        ...(signal ? [signal] : []),
      ])
      try {
        custody = await untilAborted(this.#connect(generation), combined.signal)
      } catch (error) {
        if (!generation.ended) {
          // Aborted, or the connect failed: this acquirer holds nothing.
          this.#giveBack(generation)
          throw error
        }
        return this.#again(signal, retry)
      } finally {
        combined.dispose()
      }
    }
    if (generation.ended) return this.#again(signal, retry)
    if (signal?.aborted) {
      this.#giveBack(generation)
      throw signal.reason
    }
    return this.#lease(generation, custody)
  }

  /** An acquirer whose generation ended while it waited. */
  #again(
    signal: AbortSignal | undefined,
    retry: boolean,
  ): Promise<CustodyLease> {
    signal?.throwIfAborted()
    this.#assertOpen()
    if (this.#active === false) throw notActive()
    if (!retry) throw closed()
    const generation = this.#current ?? this.#startGeneration()
    generation.count++
    return this.#settle(generation, signal, false)
  }

  #lease(
    generation: Generation,
    custody: ClaustrumScopedCustody,
  ): CustodyLease {
    const state: LeaseState = { generation, custody, released: false }
    const check = () => {
      if (state.released || generation.ended) throw closed()
    }
    const view: ClaustrumLeasedCustody = Object.freeze({
      authorize: async (identity, signal, routeId) => {
        check()
        // Work in flight stops when the generation ends.
        const combined = combineAbortSignals([
          generation.controller.signal,
          ...(signal ? [signal] : []),
        ])
        try {
          return await custody.authorize(identity, combined.signal, routeId)
        } finally {
          combined.dispose()
        }
      },
      reportFailure: async (attempt, status, source) => {
        check()
        return custody.reportFailure(attempt, status, source)
      },
      forget: (credentialId) => {
        check()
        custody.forget(credentialId)
      },
      keptReceiptState: () => {
        check()
        return custody.keptReceiptState()
      },
    })
    const lease: CustodyLease = Object.freeze({
      custody: view,
      generation: generation.id,
      release: () => {
        if (state.released) return
        state.released = true
        this.#giveBack(generation)
      },
    })
    this.#leases.set(lease, state)
    return lease
  }

  /** The current connection and its lease count, for status and tests. */
  leaseState(): { readonly generation?: number; readonly count: number } {
    const current = this.#current
    return Object.freeze({
      generation: current?.id,
      count: current?.count ?? 0,
    })
  }

  // --- authority ---

  /**
   * Read authority. The first false read after a true one (or before any)
   * runs the inactive transition; nothing else does.
   */
  async #readAuthority(): Promise<boolean> {
    const active = (await this.#options.isCustodyActive?.()) ?? true
    if (this.#shutdown.signal.aborted) return false
    const was = this.#active
    this.#active = active
    if (!active && was !== false) this.#deactivate()
    return active
  }

  /** Vault mode went off. Kept receipts never survive into local mode. */
  #deactivate(): void {
    this.#epoch++
    const current = this.#current
    if (current) this.#end(current, notActive())
    this.#own = undefined
    this.#watch?.watch.close()
    this.#watch = undefined
    this.#committed = undefined
    this.#discoveredAt = undefined
    for (const entry of this.#members.values()) {
      entry.seen = undefined
      entry.hooks?.reset()
      forgetPendingVaultDiscovery(entry.path)
    }
  }

  // --- discovery ---

  /** Members built and not closed, in the order the hub was given them. */
  #open(): MemberEntry[] {
    return [...this.#members.values()].filter(
      (entry) => entry.hooks && !entry.closed,
    )
  }

  /** The hub's own lease, taken in the current generation when needed. */
  async #ownLease(): Promise<LeaseState> {
    const held = this.#own
    const heldState = held && this.#leases.get(held)
    if (held && heldState && this.#leaseLive(held)) return heldState
    this.#own = undefined
    const lease = await this.acquire(this.#shutdown.signal)
    const raced = this.#own && this.#leases.get(this.#own)
    if (this.#own && raced && this.#leaseLive(this.#own)) {
      lease.release()
      return raced
    }
    this.#own = lease
    const state = this.#leases.get(lease)
    if (!state) throw closed()
    return state
  }

  /**
   * One coalesced refresh. A run whose generation ended is never joined: a
   * refresh after vault mode went off and on again starts a new one.
   */
  #refresh(): Promise<HubRefreshOutcome | undefined> {
    try {
      this.#assertOpen()
    } catch (error) {
      return Promise.reject(error)
    }
    const running = this.#run
    if (running && !running.generation?.ended) return running.promise
    const run: { generation?: Generation; promise?: Run['promise'] } = {}
    const promise = this.#discover(run).finally(() => {
      if (this.#run === run) this.#run = undefined
    })
    run.promise = promise
    this.#run = run as Run
    return promise
  }

  /**
   * List once, then commit each member's share of the listing to its roster,
   * push it into the member, and retain the union. Each publication step
   * checks first that the generation it started in is still current.
   */
  async #discover(run: {
    generation?: Generation
  }): Promise<HubRefreshOutcome | undefined> {
    if (!(await this.#readAuthority())) return undefined
    const own = await this.#ownLease()
    const generation = own.generation
    run.generation = generation
    if (!this.#live(generation)) return undefined
    let inventory: VaultInventory
    try {
      inventory = await own.custody.discover(generation.controller.signal)
    } catch (error) {
      if (!this.#live(generation)) return undefined
      throw error
    }
    const errors = new Map<string, unknown>()
    let complete = true
    for (const entry of this.#open()) {
      if (!this.#live(generation)) return undefined
      const hooks = entry.hooks
      if (!hooks || entry.closed) continue
      const share: VaultInventory = {
        ...inventory,
        credentials: inventory.credentials.filter(
          (credential) => credential.member === entry.provider,
        ),
        skipped: inventory.skipped.filter(
          (record) => record.member === entry.provider,
        ),
      }
      let roster: VaultRosterFile | undefined
      try {
        roster = await refreshVaultRoster({
          path: entry.path,
          custody: { discover: async () => share },
          // Generation g's commit checks that g is still current, not only
          // that vault mode is on, so off-then-on cannot let it into g+1.
          isActive: () => this.#live(generation) && this.#active === true,
          signal: generation.controller.signal,
          projection: () => hooks.projection(),
        })
      } catch (error) {
        if (!this.#live(generation)) return undefined
        errors.set(entry.provider, error)
        complete = false
        continue
      }
      if (!this.#live(generation)) return undefined
      if (!roster) {
        complete = false
        continue
      }
      if (roster.view !== inventory.view) complete = false
      // The push: memory holds the committed roster before refresh resolves.
      entry.seen = JSON.stringify(decodedVaultRoster(roster))
      if (!entry.closed) hooks.install(roster)
    }
    if (!this.#live(generation)) return undefined
    this.#retainUnion()
    // The committed view, and the refusals and grant reach tied to it, move
    // only when every member committed this listing.
    if (complete)
      this.#committed = Object.freeze({
        view: inventory.view,
        ...(inventory.grantReach && { reach: inventory.grantReach }),
        refused: Object.freeze([...(inventory.refused ?? [])]),
        notMine: inventory.notMine ?? 0,
      })
    this.#discoveredAt = (this.#options.now ?? Date.now)()
    return { errors }
  }

  /** Retain kept receipts against every open member's roster in memory. */
  #retainUnion(): void {
    const custody = this.#current?.custody
    if (!custody) return
    custody.retain(
      this.#open().flatMap((entry) => entry.hooks?.roster()?.rows ?? []),
    )
  }

  /**
   * Install member files that changed under the view in memory: a decline,
   * accept, reorder or quota reading written by another writer. Local reads
   * only. A file with a different view is left to the next list, which
   * projects it.
   */
  async #install(): Promise<void> {
    const epoch = this.#epoch
    for (const entry of this.#open()) {
      let file: VaultRosterFile | undefined
      try {
        file = await readVaultRoster(entry.path)
      } catch (error) {
        entry.hooks?.onError(error)
        continue
      }
      if (epoch !== this.#epoch || this.#active !== true) return
      const hooks = entry.hooks
      if (!file || !hooks || entry.closed) continue
      const content = JSON.stringify(file)
      const memory = hooks.roster()
      if (content === entry.seen || !memory || memory.view !== file.view)
        continue
      const before = enabledRows(memory)
      entry.seen = content
      hooks.install(file)
      if (enabledRows(hooks.roster()) !== before) this.#retainUnion()
    }
  }

  /** Whether a tick must list now; the consumer's rule, once for every member. */
  #listDue(): boolean {
    if (this.#watch?.watch.mode !== 'watching') return true
    const now = (this.#options.now ?? Date.now)()
    return (
      this.#discoveredAt === undefined ||
      now - this.#discoveredAt >= SAFETY_POLL_MS
    )
  }

  /** Open the one vault watch on the hub's own lease, once per generation. */
  #openWatch(): void {
    const own = this.#own
    const state = own && this.#leases.get(own)
    if (!own || !state || !this.#leaseLive(own) || this.#active !== true) return
    const generation = state.generation
    if (!this.#live(generation) || this.#watch?.generation === generation)
      return
    const watch = state.custody.watchRoster({
      view: () => this.#committed?.view,
      onView: async () => {
        // A refresh already in flight may have listed before the change was
        // announced, so wait for it and list again.
        while (this.#run) await this.#run.promise.catch(() => {})
        if (!this.#live(generation)) return
        this.#publish(await this.#refresh())
      },
      onRefused: (error) => this.#error(error),
      onError: (error) => this.#error(error),
    })
    this.#watch = { generation, watch }
  }

  #error(error: unknown): void {
    if (!this.#shutdown.signal.aborted) this.#options.onError?.(error)
  }

  /** Each member's own commit error goes to that member's `onError` only. */
  #publish(outcome: HubRefreshOutcome | undefined): void {
    for (const [provider, error] of outcome?.errors ?? [])
      this.#members.get(provider)?.hooks?.onError(error)
  }

  async #tick(): Promise<void> {
    try {
      if (await this.#readAuthority()) {
        await this.#install()
        if (this.#listDue()) this.#publish(await this.#refresh())
        this.#openWatch()
      }
    } catch (error) {
      this.#error(error)
    }
    if (this.#shutdown.signal.aborted) return
    const delay = this.#options.pollIntervalMs ?? 5_000
    if (delay <= 0) return
    this.#timer = (this.#options.setTimeoutImpl ?? setTimeout)(() => {
      this.#timer = undefined
      void this.#tick()
    }, delay)
    this.#timer.unref?.()
  }

  /**
   * Start the hub's tick, which runs until `close()`. While vault mode is
   * off a tick only reads authority and makes no vault request.
   */
  start(): void {
    if (this.#started) return
    this.#assertOpen()
    this.#started = true
    void this.#tick()
  }

  /**
   * List once and commit every member, as a tick does. Resolves once every
   * member's memory holds its new roster. Rejects when the list fails; a
   * member's own commit error goes to that member's `onError`.
   */
  async refresh(): Promise<void> {
    this.#publish(await this.#refresh())
  }

  // --- accessors, without I/O ---

  /**
   * Rows the last discovery every member committed refused, with their fixed
   * codes, and how many rows it left to other plugins. Undefined while
   * unknown: before a complete discovery, and while vault mode is off.
   */
  refusals(): ClaustrumHubRefusals | undefined {
    const committed = this.#committed
    return (
      committed &&
      Object.freeze({
        view: committed.view,
        refused: committed.refused,
        notMine: committed.notMine,
      })
    )
  }

  /** The grant reach of the same discovery as `refusals()`. */
  grantReach(): VaultGrantReach | undefined {
    return this.#committed?.reach
  }

  /** How the hub learns about changes; `polling` until a watch is open. */
  watchState(): WatchMode {
    const open = this.#watch
    return open && this.#live(open.generation) ? open.watch.mode : 'polling'
  }

  /** The shared custody's kept receipts, host-wide. */
  keptReceiptState(): KeptReceiptState {
    return (
      this.#current?.custody?.keptReceiptState() ??
      Object.freeze({ active: false, since: null })
    )
  }

  /**
   * Stop the tick and the watch and close the connection. Members are not
   * closed; they fail `closed` from then on.
   */
  close(): void {
    if (this.#shutdown.signal.aborted) return
    this.#shutdown.abort(closed('Claustrum discovery hub is closed'))
    if (this.#timer)
      (this.#options.clearTimeoutImpl ?? clearTimeout)(this.#timer)
    this.#timer = undefined
    const current = this.#current
    if (current) this.#end(current)
    this.#own = undefined
    this.#watch?.watch.close()
    this.#watch = undefined
  }
}
