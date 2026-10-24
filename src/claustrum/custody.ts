import {
  type ClaustrumClient,
  ClaustrumCredentialError,
  type ClaustrumReporterSource,
  type EnrollmentTokenFile,
  type ScopedInventoryRow,
} from '@cortexkit/claustrum-client'
import { createLogger } from '../logger/index.js'
import {
  ClaustrumUnreachableError,
  classifyVaultFailure,
} from './availability.js'
import { readClaustrumEnrollmentToken } from './enrollment.js'
import { ClaustrumConsumerError, type ClaustrumLogger } from './errors.js'
import { CUSTODY_PLACEHOLDER_PREFIX } from './host-slot.js'
import type { InsulaUsageTransport } from './insula.js'
import { drainShutdown, shutdownWarning } from './shutdown.js'
import {
  ScopedRosterWatch,
  type ScopedWatchSource,
  type WatchMode,
} from './watch.js'

/**
 * `watchScoped` is present from claustrum-client 0.12.0. Hosts detect it at
 * run time and keep polling without it.
 */
export type ClaustrumScopedClient = Pick<
  ClaustrumClient,
  'listScoped' | 'getScoped' | 'reportAuthFailureScoped' | 'close'
> & { insula?: InsulaUsageTransport } & ScopedWatchSource

/** The two credential types a plugin's family can hold; routing differs by type. */
export type VaultCredentialType = 'oauth' | 'api_key'

/**
 * Which vault rows belong to this plugin. `refreshAdapter` classifies an OAuth
 * row by the protocol it speaks; `category` is the grant that authorizes this
 * consumer to read it. Static API keys carry no refresh adapter, so they are
 * admitted only when `apiKeys` is set and only by category.
 */
export interface ClaustrumFamily {
  refreshAdapter: string
  category: string
  apiKeys?: boolean
}

/** Non-secret classification facts, including rows decoded by older clients. */
export interface VaultRowFacts {
  readonly credentialId: string
  readonly credentialType: string
  readonly authMethod?: string
  readonly refreshAdapter?: string
  readonly providerIds?: readonly string[]
  readonly categories: readonly string[]
}

/** A policy that partitions one category without requiring one OAuth adapter. */
export interface ClassifyingClaustrumFamily<Code extends string> {
  category: string
  refusalCodes: readonly Code[]
  classify(
    row: VaultRowFacts,
  ):
    | { kind: 'not-mine' }
    | { kind: 'mine'; member: string }
    | { kind: 'refused'; code: Code }
}

export type ClaustrumFamilyInput =
  | ClaustrumFamily
  | ClassifyingClaustrumFamily<string>

/** One vault credential this consumer may serve. Never carries bearer material. */
export interface VaultCredential {
  readonly credentialId: string
  readonly credentialType: VaultCredentialType
  readonly member?: string
  /**
   * The provider account the credential logs into, when the vault's adapter
   * claims one. Absent means the adapter makes no claim, not a mismatch.
   */
  readonly accountIdentity?: string
  readonly state: string
  readonly email?: string
  readonly orgName?: string
}

/**
 * Why a listed vault record could not be used. A closed set of fixed codes, so
 * a log line or a roster file that carries one never echoes vault data.
 */
export type SkippedVaultReason =
  | 'empty credential id'
  | 'duplicate credential id'
  | 'blank account identity'
  | 'empty state'

/**
 * A vault record this consumer could not use. `credentialId` is absent when
 * the record's id itself was unusable, so nothing can say which account the
 * record was.
 */
export interface SkippedVaultRecord {
  readonly credentialId?: string
  readonly member?: string
  readonly reason: SkippedVaultReason
}

/**
 * One grant this consumer's enrollment holds, as the vault's list reply names
 * it: for example `{ selectorKind: 'category', selector: 'openai-native',
 * operation: 'read' }`. `selectorKind` is `exact` (the selector is a credential
 * id) or `category` (a bare category name); both open strings.
 */
export interface VaultGrantTuple {
  readonly selectorKind: string
  readonly selector: string
  readonly operation: string
}

/**
 * What this consumer is granted, independent of what those grants currently
 * reach. It is what tells two empty listings apart: no rows with `grants === 0`
 * means no grant at all (the fix is `ck auth grant`), while no rows with
 * `grants > 0` means a grant that reaches no credential, usually logins that
 * lack the category (`ck auth reclassify --from-registry`); `tuples` names the
 * selector that matched nothing. Never written to the roster file.
 */
export interface VaultGrantReach {
  /** How many grants the consumer holds, deposit grants excluded. */
  readonly grants: number
  readonly tuples: readonly VaultGrantTuple[]
}

/**
 * The grant fields of `listScoped`'s reply. claustrum-client 0.10.0 decodes
 * them (and refuses malformed values); older clients, and any client talking
 * to a vault too old to send them, leave them undefined.
 */
interface ListedGrantReach {
  readonly grants?: number
  readonly grantTuples?: readonly VaultGrantTuple[]
}

export interface VaultInventory {
  /**
   * The vault's change cursor: a digest over exactly what this consumer can see
   * (ids, grants, state, identity), never over record versions, so a routine
   * token refresh does not move it. Only equality is meaningful.
   */
  readonly view: string
  readonly credentials: readonly VaultCredential[]
  readonly skipped: readonly SkippedVaultRecord[]
  /** Classifying families only: fixed refusal codes, never classifier errors. */
  readonly refused?: readonly { credentialId?: string; code: string }[]
  /** Classifying families only: rows outside this family's responsibility. */
  readonly notMine?: number
  /**
   * The consumer's grants, as the vault's list reply named them. Undefined means unknown
   * (the vault or client predates the fields), never zero grants.
   */
  readonly grantReach?: VaultGrantReach
}

export interface ClaustrumScopedIdentity {
  readonly credentialId: string
  readonly credentialType: VaultCredentialType
  readonly accountIdentity?: string
}

/**
 * Where a receipt's `accountIdentity` came from: the vault asserted it in the
 * served reply, the plugin's `parseIdentity` read it from the served token, or
 * neither did and it is only the roster's expectation (`none`: no identity at
 * all).
 */
export type AccountIdentitySource = 'asserted' | 'parsed' | 'expected' | 'none'

/**
 * A receipt: what the vault served for one physical send. Each attempt gets
 * its own. It records the exact record version served, because a 401 for
 * this send is reported to the vault against that version.
 */
export interface ClaustrumScopedAttempt {
  readonly credentialId: string
  readonly credentialType: VaultCredentialType
  /**
   * The account this receipt is bound to: the vault's assertion, else the
   * plugin's parse of the token, else the roster's expectation. Check
   * `accountIdentitySource` before treating it as proof.
   */
  readonly accountIdentity?: string
  readonly accountIdentitySource: AccountIdentitySource
  /** The account the roster row named when this receipt was requested. */
  readonly expectedAccountIdentity?: string
  /** The credential id the vault itself put in the served reply, if any. */
  readonly assertedCredentialId?: string
  /**
   * The account the vault itself put in the served reply, if any. Never filled
   * in from the roster or from a token parse.
   */
  readonly assertedAccountIdentity?: string
  /**
   * The non-secret Google Cloud project id the vault served in get_scoped for
   * this attempt, if any. Never filled in from list_scoped, the roster or a
   * token parse. A project change in the vault takes effect on the next send.
   */
  readonly projectId?: string
  /**
   * Kept in memory only and hidden from JSON.stringify and object spreads, so
   * logging a receipt never leaks it. Authorize again for every dispatch and retry.
   */
  readonly accessToken: string
  readonly recordVersion: number
  readonly expiresAtMs: number | null
  /**
   * True when this receipt was not freshly served but is the last token kept
   * from an earlier read, used because the vault could not be reached. A 401
   * with such a receipt must not be retried and is not reported to the vault,
   * which is unreachable.
   */
  readonly fromKeptReceipt?: true
}

export interface KeptReceiptState {
  readonly active: boolean
  readonly since: number | null
}

interface KeptReceipt {
  readonly attempt: ClaustrumScopedAttempt
  readonly routeId: string
  since: number | null
}

export interface ClaustrumRosterWatchOptions {
  /**
   * Run the host's own discovery (`custody.discover()`, then its roster
   * commit). Called with the newest notice's view when that view differs from
   * the last discovered one, when a notice shows a sequence gap or a new
   * epoch, and on the first notice of a watch re-opened after a close (the
   * time between two watches was not observed). One call runs at a time;
   * notices that arrive meanwhile earn at most one more call, which runs only
   * if the view still differs. A rejection goes to `onError`.
   */
  onView: (view: string) => unknown
  /**
   * The view of the roster the host last committed. Defaults to the view of
   * the last successful `custody.discover()` (outage probes excluded). Pass it
   * when the host can commit a roster it did not list itself (a peer process
   * held the discovery lease) or can fail after listing.
   */
  view?: () => string | undefined
  /**
   * Called whenever the mode changes. The watch starts in `polling`. Keep the
   * host's own list timer at its usual pace unless the mode is `watching`.
   */
  onMode?: (mode: WatchMode) => void
  /**
   * The vault refused the watch, and its confirming `list_scoped` read it with
   * this error (a revoked enrollment answers `not_found`). Custody has already
   * applied it as it applies a refused discovery (`listFailed`: every kept
   * receipt is dropped); handle it as the host handles that refusal.
   */
  onRefused?: (error: unknown) => void
  /** A failed `onView`, or a watch that could not be opened. */
  onError?: (error: unknown) => void
}

/** A vault watch held by a custody; see `ClaustrumScopedCustody.watchRoster`. */
export interface ClaustrumRosterWatch {
  /** How the host currently learns about changes. */
  readonly mode: WatchMode
  /** Stop the watch and its timers. Safe to call more than once. */
  close(): void
}

/** Reads the provider identity a served token executes under, when the plugin can tell. */
export type IdentityParser = (accessToken: string) => string | undefined

/** Only a new version of the same account may replace an in-flight 401. */
export function isScopedCredentialRotation(
  served: ClaustrumScopedAttempt,
  current: ClaustrumScopedAttempt | undefined,
): current is ClaustrumScopedAttempt {
  return (
    current !== undefined &&
    !current.fromKeptReceipt &&
    !served.fromKeptReceipt &&
    current.credentialId === served.credentialId &&
    current.accountIdentity === served.accountIdentity &&
    current.recordVersion !== served.recordVersion
  )
}

/** Why a scoped 401 did or did not retry. Never carries credential material. */
export type ScopedRetryReason =
  | 'rotated'
  | 'reauthorize-failed'
  | 'credential-changed'
  | 'account-changed'
  | 'version-unchanged'

function scopedRetryReason(
  served: ClaustrumScopedAttempt,
  current: ClaustrumScopedAttempt | undefined,
): ScopedRetryReason {
  if (current === undefined) return 'reauthorize-failed'
  if (current.credentialId !== served.credentialId) return 'credential-changed'
  if (current.accountIdentity !== served.accountIdentity)
    return 'account-changed'
  if (current.recordVersion === served.recordVersion) return 'version-unchanged'
  return 'rotated'
}

const defaultLogger = createLogger('claustrum')

/**
 * Decide whether a request that got a 401 should retry with the freshly
 * re-authorized receipt, and log the decision. The vault can refresh a
 * credential between the send and the 401; the log line lets that refresh be
 * matched against the consumer's retry. `site` names the kind of request.
 */
export function decideScopedRetryAfter401(
  site: string,
  served: ClaustrumScopedAttempt,
  current: ClaustrumScopedAttempt | undefined,
  logger: ClaustrumLogger = defaultLogger,
): current is ClaustrumScopedAttempt {
  const retry = isScopedCredentialRotation(served, current)
  logger.debug('scoped 401 re-authorized', {
    site,
    credentialId: served.credentialId,
    servedVersion: served.recordVersion,
    currentVersion: current?.recordVersion ?? null,
    retry,
    reason: scopedRetryReason(served, current),
  })
  return retry
}

/**
 * How long a served OAuth token must stay valid after the vault hands it out,
 * so it cannot expire while a long request is still using it.
 */
export const SERVING_MARGIN_MS = 300_000

/** A kept receipt needs a minute of headroom, not the vault's refresh demand. */
export const KEPT_RECEIPT_MARGIN_MS = 60_000

function invalidMaterial(): ClaustrumConsumerError {
  return new ClaustrumConsumerError(
    'invalid-material',
    'Claustrum returned invalid credential material',
  )
}

function accessTokenFromMaterial(material: string): string {
  let access = material.trim()
  if (access.startsWith('{')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(access)
    } catch {
      throw invalidMaterial()
    }
    if (!parsed || typeof parsed !== 'object') throw invalidMaterial()
    const record = parsed as Record<string, unknown>
    const value = record.access_token ?? record.access
    access = typeof value === 'string' ? value : ''
  }
  // A header-safe token only: control characters could split the request,
  // and the custody placeholder must never be sent as a credential.
  if (
    !/^[\x21-\x7e]+$/.test(access) ||
    access.startsWith(CUSTODY_PLACEHOLDER_PREFIX)
  ) {
    throw invalidMaterial()
  }
  return access
}

type ClassifiedCredential =
  | { kind: 'not-mine' }
  | { kind: 'mine'; type: VaultCredentialType; member?: string }
  | { kind: 'refused'; code: string }

function credentialTypeOf(
  row: ScopedInventoryRow,
  family: ClaustrumFamilyInput,
): ClassifiedCredential {
  const notMine = { kind: 'not-mine' } as const
  if (!row.operations.includes('read')) return notMine
  if (!row.categories.includes(family.category)) return notMine
  if (row.credentialType !== 'oauth' && row.credentialType !== 'api_key')
    return notMine
  if ('classify' in family) {
    // Older clients omit these facts entirely; do not call a policy that needs them.
    const facts: VaultRowFacts = {
      credentialId: row.id,
      credentialType: row.credentialType,
      categories: row.categories,
      refreshAdapter: row.refreshAdapter,
      ...rowFactsOf(row),
    }
    if (facts.providerIds === undefined)
      return { kind: 'refused', code: 'unmapped' }
    try {
      const result = family.classify(facts)
      if (result.kind === 'not-mine') return notMine
      if (result.kind === 'mine' && typeof result.member === 'string')
        return { kind: 'mine', type: row.credentialType, member: result.member }
      if (
        result.kind === 'refused' &&
        typeof result.code === 'string' &&
        /^[a-z][a-z0-9-]{0,31}$/.test(result.code) &&
        !result.code.includes('\n') &&
        family.refusalCodes.includes(result.code)
      )
        return { kind: 'refused', code: result.code }
    } catch {
      // A classifier error may contain vault data; expose only a fixed code.
    }
    return { kind: 'refused', code: 'unclassified' }
  }
  if (row.credentialType === 'oauth')
    return row.refreshAdapter === family.refreshAdapter
      ? { kind: 'mine', type: 'oauth' }
      : notMine
  if (row.credentialType === 'api_key' && family.apiKeys)
    return row.refreshAdapter === undefined
      ? { kind: 'mine', type: 'api_key' }
      : notMine
  return notMine
}

/** Structural access keeps the public facts independent of client declarations. */
function rowFactsOf(row: {
  readonly id: string
}): Pick<VaultRowFacts, 'providerIds' | 'authMethod'> {
  const metadata = row as {
    readonly providerIds?: readonly string[]
    readonly authMethod?: string
  }
  return { providerIds: metadata.providerIds, authMethod: metadata.authMethod }
}

/**
 * The grants named in the vault's list reply, or undefined when it names none.
 * Both fields must be present: a reply carrying only one of them is treated as
 * unknown rather than completed with a guess. claustrum-client already refuses
 * a malformed value, so nothing here validates it again.
 */
function grantReachOf(
  listed: ListedGrantReach & { readonly view: string },
): VaultGrantReach | undefined {
  const { grants, grantTuples } = listed
  if (grants === undefined || grantTuples === undefined) return undefined
  return Object.freeze({
    grants,
    tuples: Object.freeze(
      grantTuples.map(({ selectorKind, selector, operation }) =>
        Object.freeze({ selectorKind, selector, operation }),
      ),
    ),
  })
}

/**
 * Reads this consumer's vault credentials (list, fetch, 401 report), with the
 * enrollment token as authorization. Used by every host of a plugin. Every
 * physical send asks the vault first while reachable. Only an unreachable vault permits
 * reuse of the last validated receipt, in memory and bounded by its expiry.
 * The enrollment token is re-read per operation so revocation and disconnect
 * still take effect without a process restart.
 */
export class ClaustrumScopedCustody {
  readonly #client: ClaustrumScopedClient
  readonly #readToken: () => Promise<EnrollmentTokenFile>
  readonly #now: () => number
  readonly #family: ClaustrumFamilyInput
  readonly #parseIdentity?: IdentityParser
  readonly #requireAssertion: boolean
  readonly #logger: ClaustrumLogger
  readonly #provenance = new WeakMap<ClaustrumScopedAttempt, string>()
  readonly #reports = new WeakMap<ClaustrumScopedAttempt, Promise<void>>()
  readonly #kept = new Map<string, KeptReceipt>()
  readonly #keptAttempts = new WeakMap<ClaustrumScopedAttempt, string>()
  readonly #setTimeout: typeof setTimeout
  readonly #clearTimeout: typeof clearTimeout
  #outage = false
  #outageError: unknown = new ClaustrumUnreachableError()
  #probeTimer?: ReturnType<typeof setTimeout>
  #probing = false
  #lastProbeAt = -Infinity
  #probeDelay = 2_000
  #closed = false
  /** The view of the last successful `discover()`, for `watchRoster`. */
  #discoveredView?: string
  readonly #watches = new Set<ScopedRosterWatch>()
  readonly #tokenReads = new Set<Promise<EnrollmentTokenFile>>()
  readonly #warnShutdown: (pendingOperations: number) => void
  #disposing?: Promise<void>

  constructor(options: {
    client: ClaustrumScopedClient
    family: ClaustrumFamilyInput
    tokenPath?: string
    readToken?: () => Promise<EnrollmentTokenFile>
    parseIdentity?: IdentityParser
    /**
     * Issue a receipt only when the vault's served reply itself names the
     * requested credential id and the roster's (known) account identity. For
     * providers whose tokens are opaque, where nothing else can prove which
     * account a token belongs to. Off by default: then an absent assertion is
     * no claim, and the receipt says where its identity came from.
     */
    requireAssertion?: boolean
    now?: () => number
    logger?: ClaustrumLogger
    setTimeoutImpl?: typeof setTimeout
    clearTimeoutImpl?: typeof clearTimeout
  }) {
    const tokenPath = options.tokenPath
    if (options.readToken) {
      this.#readToken = options.readToken
    } else if (tokenPath) {
      this.#readToken = () => readClaustrumEnrollmentToken(tokenPath)
    } else {
      throw new ClaustrumConsumerError(
        'not-enrolled',
        'Claustrum enrollment token path is required',
      )
    }
    this.#client = options.client
    this.#family = options.family
    this.#parseIdentity = options.parseIdentity
    this.#requireAssertion = options.requireAssertion ?? false
    this.#now = options.now ?? Date.now
    this.#logger = options.logger ?? defaultLogger
    this.#warnShutdown = shutdownWarning(this.#logger)
    this.#setTimeout = options.setTimeoutImpl ?? setTimeout
    this.#clearTimeout = options.clearTimeoutImpl ?? clearTimeout
  }

  /** A watch losing its transport is the same outage as an unreachable read. */
  transportLost(error?: unknown): void {
    if (this.#closed || this.#outage) return
    this.#outage = true
    this.#outageError =
      error instanceof ClaustrumCredentialError
        ? error
        : new ClaustrumUnreachableError()
    this.#logger.warn('serving kept vault receipt', { reason: 'unreachable' })
    this.#scheduleProbe()
  }

  /** Any vault answer ends transport fallback, even when it refuses access. */
  reachable(): void {
    if (this.#closed || !this.#outage) return
    this.#outage = false
    if (this.#probeTimer) this.#clearTimeout(this.#probeTimer)
    this.#probeTimer = undefined
    this.#probeDelay = 2_000
    for (const kept of this.#kept.values()) kept.since = null
    ;(this.#logger.info ?? defaultLogger.info)(
      'vault receipt serving resumed',
      { reason: 'reachable' },
    )
  }

  #scheduleProbe(): void {
    if (this.#closed || !this.#outage || this.#probeTimer || this.#probing)
      return
    this.#probeTimer = this.#setTimeout(() => {
      this.#probeTimer = undefined
      this.#probe(true)
    }, this.#probeDelay)
    this.#probeTimer.unref?.()
  }

  #probe(idle = false): void {
    if (this.#closed || !this.#outage || this.#probing) return
    if (this.#now() - this.#lastProbeAt < 1_000) {
      this.#scheduleProbe()
      return
    }
    this.#lastProbeAt = this.#now()
    this.#probing = true
    // Both triggers share list_scoped discovery, including its receipt-drop rules.
    // Sends never await discovery or let idle backoff delay the next send probe.
    // A probe commits no roster, so it is not the host's discovery and does
    // not move the view a roster watch compares notices against.
    void this.#list()
      .catch(() => {
        if (idle && this.#outage)
          this.#probeDelay = Math.min(this.#probeDelay * 2, 30_000)
      })
      .finally(() => {
        this.#probing = false
        this.#scheduleProbe()
      })
  }

  #check(signal?: AbortSignal): void {
    if (this.#closed)
      throw new ClaustrumConsumerError(
        'closed',
        'Claustrum scoped custody is closed',
      )
    signal?.throwIfAborted()
  }

  async #token(signal?: AbortSignal): Promise<string> {
    this.#check(signal)
    const pending = this.#readToken()
    this.#tokenReads.add(pending)
    let value: EnrollmentTokenFile
    try {
      value = await pending
    } finally {
      this.#tokenReads.delete(pending)
    }
    this.#check(signal)
    if (
      !/^[0-9a-f]{64}$/.test(value.token) ||
      !Number.isSafeInteger(value.token_generation) ||
      value.token_generation < 1
    ) {
      throw new ClaustrumConsumerError(
        'invalid-token',
        'Invalid Claustrum enrollment token',
      )
    }
    return value.token
  }

  async #call<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.#check(signal)
    let result: T
    let removeAbortListener: (() => void) | undefined
    try {
      const pending = operation()
      result = signal
        ? await Promise.race([
            pending,
            new Promise<never>((_resolve, reject) => {
              const abort = () => reject(signal.reason)
              signal.addEventListener('abort', abort, { once: true })
              removeAbortListener = () =>
                signal.removeEventListener('abort', abort)
              if (signal.aborted) abort()
            }),
          ])
        : await pending
    } catch (error) {
      this.#check(signal)
      if (classifyVaultFailure(error) === 'unreachable')
        this.transportLost(error)
      else this.reachable()
      // Keep the vault's own refusals (ClaustrumCredentialError, carrying
      // code, class and action); replace any other error, whose text may echo
      // request params that include the enrollment token.
      if (error instanceof ClaustrumCredentialError) throw error
      if (classifyVaultFailure(error) === 'unreachable')
        throw new ClaustrumUnreachableError()
      throw new ClaustrumConsumerError(
        'unavailable',
        'Claustrum scoped operation unavailable',
      )
    } finally {
      removeAbortListener?.()
    }
    this.#check(signal)
    this.reachable()
    return result
  }

  /**
   * List this consumer's credentials. A record that cannot be used is skipped
   * and warned about rather than failing the whole list, so one bad record
   * never hides every other account. Records outside the family are not
   * skipped records: they simply are not this consumer's.
   */
  async discover(signal?: AbortSignal): Promise<VaultInventory> {
    const inventory = await this.#list(signal)
    this.#discoveredView = inventory.view
    return inventory
  }

  async #list(signal?: AbortSignal): Promise<VaultInventory> {
    let inventory: Awaited<ReturnType<ClaustrumScopedClient['listScoped']>>
    let token: string
    try {
      token = await this.#token(signal)
    } catch (error) {
      this.#kept.clear()
      throw error
    }
    try {
      inventory = await this.#call(() => this.#client.listScoped(token), signal)
    } catch (error) {
      this.listFailed(error)
      throw error
    }
    const skipped: SkippedVaultRecord[] = []
    const refused: { credentialId?: string; code: string }[] = []
    let notMine = 0
    const candidates: Array<{
      row: ScopedInventoryRow
      type: VaultCredentialType
      member?: string
    }> = []
    const counts = new Map<string, number>()
    for (const row of inventory.rows) {
      const classified = credentialTypeOf(row, this.#family)
      if (classified.kind === 'not-mine') {
        notMine++
        continue
      }
      if (classified.kind === 'refused') {
        refused.push({
          ...(row.id.trim() && { credentialId: row.id }),
          code: classified.code,
        })
        continue
      }
      candidates.push({
        row,
        type: classified.type,
        ...(classified.member !== undefined && { member: classified.member }),
      })
      counts.set(row.id, (counts.get(row.id) ?? 0) + 1)
    }
    const credentials: VaultCredential[] = []
    for (const { row, type, member } of candidates) {
      let reason: SkippedVaultReason | undefined
      if (!row.id.trim()) reason = 'empty credential id'
      else if ((counts.get(row.id) ?? 0) > 1) reason = 'duplicate credential id'
      else if (row.accountId !== undefined && !row.accountId.trim())
        reason = 'blank account identity'
      else if (!row.state.trim()) reason = 'empty state'
      if (reason) {
        skipped.push({
          ...(row.id.trim() && { credentialId: row.id }),
          ...(member !== undefined && { member }),
          reason,
        })
        continue
      }
      credentials.push(
        Object.freeze({
          credentialId: row.id,
          credentialType: type,
          ...(member !== undefined && { member }),
          ...(row.accountId !== undefined && {
            accountIdentity: row.accountId,
          }),
          state: row.state,
          ...(row.email !== undefined && { email: row.email }),
          ...(row.orgName !== undefined && { orgName: row.orgName }),
        }),
      )
    }
    for (const record of skipped)
      this.#logger.warn('skipped malformed vault record', record)
    const grantReach = grantReachOf(inventory)
    return {
      view: inventory.view,
      credentials: Object.freeze(credentials),
      skipped: Object.freeze(skipped),
      ...('classify' in this.#family && {
        refused: Object.freeze(refused),
        notMine,
      }),
      ...(grantReach && { grantReach }),
    }
  }

  /**
   * Apply a failed account listing: any answer from the vault (a refusal such
   * as a revoked enrollment's `not_found`) drops every kept receipt, while an
   * unreachable vault keeps them. A vault watch that ends with the same
   * refusal calls this too, so both paths treat it alike.
   */
  listFailed(error: unknown): void {
    if (classifyVaultFailure(error) === 'unreachable') this.transportLost(error)
    else {
      this.reachable()
      this.#kept.clear()
    }
  }

  /** Discard bearer material when a route is removed, declined or rebound. */
  forget(credentialId: string): void {
    this.#kept.delete(credentialId)
  }

  /** Apply an already-held roster; this never fetches credentials or writes it. */
  retain(
    identities: readonly (ClaustrumScopedIdentity & {
      enabled: boolean
      state: string
    })[],
  ): void {
    const current = new Map(
      identities.map((identity) => [identity.credentialId, identity]),
    )
    for (const [id, kept] of this.#kept) {
      const identity = current.get(id)
      if (
        !identity?.enabled ||
        identity.state !== 'active' ||
        identity.credentialType !== kept.attempt.credentialType ||
        identity.accountIdentity !== kept.attempt.expectedAccountIdentity
      )
        this.forget(id)
    }
  }

  /** A frozen, non-secret summary for a plugin's status display. */
  keptReceiptState(): KeptReceiptState {
    let since: number | null = null
    for (const [id, kept] of this.#kept) {
      if (!this.#usable(kept.attempt)) {
        this.forget(id)
        continue
      }
      if (kept.since !== null) since = Math.min(since ?? kept.since, kept.since)
    }
    return Object.freeze({ active: since !== null, since })
  }

  #usable(attempt: ClaustrumScopedAttempt): boolean {
    return attempt.expiresAtMs === null
      ? attempt.credentialType === 'api_key'
      : attempt.expiresAtMs - this.#now() > KEPT_RECEIPT_MARGIN_MS
  }

  /** Ask the vault while reachable; retain one validated receipt in memory only. */
  async authorize(
    identity: ClaustrumScopedIdentity,
    signal?: AbortSignal,
    routeId = 'vault',
  ): Promise<ClaustrumScopedAttempt> {
    this.#check(signal)
    const { credentialId, credentialType, accountIdentity } = identity
    let kept = this.#kept.get(credentialId)
    if (
      kept &&
      (kept.attempt.credentialType !== credentialType ||
        kept.attempt.expectedAccountIdentity !== accountIdentity)
    ) {
      this.forget(credentialId)
      kept = undefined
    }
    // A missing or invalid enrollment is not a transport outage.
    let token: string
    try {
      token = await this.#token(signal)
    } catch (error) {
      this.#kept.clear()
      throw error
    }
    if (this.#outage && kept) {
      this.#probe()
      return this.#serveKept(credentialId, kept, token, routeId)
    }
    try {
      const attempt = await this.#authorizeFresh(
        { credentialId, credentialType, accountIdentity },
        token,
        signal,
      )
      this.#kept.set(credentialId, { attempt, routeId, since: null })
      return attempt
    } catch (error) {
      this.#check(signal)
      if (classifyVaultFailure(error) !== 'unreachable') {
        this.forget(credentialId)
        throw error
      }
      return this.#serveKept(credentialId, kept, token, routeId, error)
    }
  }

  #serveKept(
    credentialId: string,
    kept: KeptReceipt | undefined,
    token: string,
    routeId: string,
    error: unknown = this.#outageError,
  ): ClaustrumScopedAttempt {
    // A concurrent refusal or 401 may already have discarded this entry.
    if (
      !kept ||
      this.#kept.get(credentialId) !== kept ||
      !this.#usable(kept.attempt)
    ) {
      this.forget(credentialId)
      throw error
    }
    if (kept.since === null) kept.since = this.#now()
    const attempt: ClaustrumScopedAttempt = Object.freeze(
      Object.defineProperty(
        { ...kept.attempt, fromKeptReceipt: true as const },
        'accessToken',
        { value: kept.attempt.accessToken, enumerable: false },
      ),
    )
    this.#provenance.set(attempt, token)
    this.#keptAttempts.set(attempt, routeId)
    return attempt
  }

  /**
   * Fetch and validate a fresh receipt before retaining it. The vault assertion
   * (or the plugin's token parse) must agree with the roster when both exist.
   * With requireAssertion, an absent assertion also refuses rather than
   * treating the roster's expectation as proof of the served account.
   */
  async #authorizeFresh(
    identity: ClaustrumScopedIdentity,
    token: string,
    signal?: AbortSignal,
  ): Promise<ClaustrumScopedAttempt> {
    if (!identity.credentialId)
      throw new ClaustrumConsumerError(
        'route-unavailable',
        'Claustrum dispatch requires a credential id',
      )
    // Capture the caller's fields before yielding so a later mutation cannot move the fence.
    const { credentialId, credentialType, accountIdentity } = identity
    if (this.#requireAssertion && accountIdentity === undefined)
      throw new ClaustrumConsumerError(
        'identity-unasserted',
        'Claustrum dispatch requires a known account identity',
      )
    const served = await this.#call(
      () =>
        this.#client.getScoped({
          credentialId,
          enrollmentToken: token,
          ...(credentialType === 'oauth' && { minTtlMs: SERVING_MARGIN_MS }),
        }),
      signal,
    )
    if (
      served.credentialId !== undefined &&
      served.credentialId !== credentialId
    ) {
      throw new ClaustrumConsumerError(
        'identity-changed',
        'Claustrum served credential identity changed',
      )
    }
    const expiresAtMs = served.expiresAtMs
    if (
      !Number.isSafeInteger(served.recordVersion) ||
      served.recordVersion < 0 ||
      (expiresAtMs === null && credentialType === 'oauth') ||
      (expiresAtMs !== null &&
        (!Number.isFinite(expiresAtMs) ||
          expiresAtMs - this.#now() < SERVING_MARGIN_MS))
    ) {
      throw new ClaustrumConsumerError(
        'insufficient-validity',
        'Claustrum served credential has insufficient validity',
      )
    }
    const accessToken = accessTokenFromMaterial(served.material)
    const assertedIdentity = served.accountId?.trim()
      ? served.accountId
      : undefined
    if (
      this.#requireAssertion &&
      (served.credentialId === undefined || assertedIdentity === undefined)
    )
      throw new ClaustrumConsumerError(
        'identity-unasserted',
        'Claustrum served credential did not assert its identity',
      )
    const parsedIdentity =
      assertedIdentity === undefined
        ? this.#parseIdentity?.(accessToken)
        : undefined
    const servedIdentity = assertedIdentity ?? parsedIdentity
    if (
      accountIdentity !== undefined &&
      servedIdentity !== undefined &&
      servedIdentity !== accountIdentity
    ) {
      throw new ClaustrumConsumerError(
        'identity-changed',
        'Claustrum served credential identity changed',
      )
    }
    const resolvedIdentity = servedIdentity ?? accountIdentity
    const source: AccountIdentitySource =
      assertedIdentity !== undefined
        ? 'asserted'
        : parsedIdentity !== undefined
          ? 'parsed'
          : accountIdentity !== undefined
            ? 'expected'
            : 'none'
    const attempt = Object.freeze(
      Object.defineProperty(
        {
          credentialId,
          credentialType,
          ...(resolvedIdentity !== undefined && {
            accountIdentity: resolvedIdentity,
          }),
          accountIdentitySource: source,
          ...(accountIdentity !== undefined && {
            expectedAccountIdentity: accountIdentity,
          }),
          ...(served.credentialId !== undefined && {
            assertedCredentialId: served.credentialId,
          }),
          ...(assertedIdentity !== undefined && {
            assertedAccountIdentity: assertedIdentity,
          }),
          ...(served.projectId !== undefined && {
            projectId: served.projectId,
          }),
          recordVersion: served.recordVersion,
          expiresAtMs,
        },
        'accessToken',
        { value: accessToken, enumerable: false },
      ),
    ) as ClaustrumScopedAttempt
    this.#provenance.set(attempt, token)
    return attempt
  }

  /**
   * Report that a send this consumer actually made was rejected. Only a 401
   * is reported (the vault refuses 429, 402 and 5xx reports), addressed by
   * credential id with the exact record version that send was served, and
   * signed with the enrollment token that authorized it. A receipt this
   * custody did not issue is refused rather than reported.
   */
  async reportFailure(
    attempt: ClaustrumScopedAttempt,
    status: number,
    reporterSource: ClaustrumReporterSource,
  ): Promise<void> {
    if (status !== 401) return
    this.#check()
    const token = this.#provenance.get(attempt)
    if (!token)
      throw new ClaustrumConsumerError(
        'no-receipt',
        'Claustrum failure report requires an original dispatch receipt',
      )
    const keptRoute = this.#keptAttempts.get(attempt)
    if (keptRoute !== undefined) {
      this.forget(attempt.credentialId)
      this.#logger.debug('scoped 401 not reported', {
        routeId: keptRoute,
        reason: 'kept-receipt',
      })
      return
    }
    // The provider rejected this token, so it must not come back as a kept
    // receipt during a later outage. Drop it before reporting, so a report that
    // fails because the vault is unreachable still drops it.
    const kept = this.#kept.get(attempt.credentialId)
    if (kept && kept.attempt.recordVersion === attempt.recordVersion)
      this.forget(attempt.credentialId)
    const pending = this.#reports.get(attempt)
    if (pending) return pending
    const report = this.#call(() =>
      this.#client.reportAuthFailureScoped({
        credentialId: attempt.credentialId,
        enrollmentToken: token,
        providerStatus: 401,
        recordVersion: attempt.recordVersion,
        reporterSource,
      }),
    )
    this.#reports.set(attempt, report)
    try {
      await report
      this.#logger.debug('scoped 401 reported', {
        credentialId: attempt.credentialId,
        recordVersion: attempt.recordVersion,
        reporterSource,
      })
    } catch (error) {
      this.#reports.delete(attempt)
      throw error
    }
  }

  /**
   * Watch this consumer's visible vault accounts instead of listing them on a
   * short timer. Opens one `watchScoped` on this custody's client and calls
   * `onView` when the host must run its discovery (see
   * `ClaustrumRosterWatchOptions`). A claustrum-client without `watchScoped`
   * (before 0.12.0) or a vault that answers `unknown_method` reports
   * `fallback` and opens nothing. A watch that closes before any notice was
   * never accepted: the client reads once to learn why, and the watch reports
   * `fallback` and tries one new watch after `WATCH_RETRY_MS`, never in a
   * loop. A watch that closes after notices is re-opened after
   * `RESUBSCRIBE_BACKOFF_MS`, doubling per close in a row. A lost transport
   * starts this custody's outage, exactly as an unreachable call does, and
   * the first notice of a watch ends it. Timers are unreferenced; `close()`
   * on the returned watch or on this custody stops it.
   *
   * The watch keeps no history, so the host still lists on a slow timer while
   * the mode is `watching`: every `SAFETY_POLL_MS` (five minutes). In any
   * other mode the host keeps its usual list timer.
   */
  watchRoster(options: ClaustrumRosterWatchOptions): ClaustrumRosterWatch {
    this.#check()
    const watch: ScopedRosterWatch = new ScopedRosterWatch({
      client: this.#client,
      enrollmentToken: () => this.#token(),
      view: options.view ?? (() => this.#discoveredView),
      discover: async (view) => {
        await options.onView(view)
      },
      onRefused: (error) => {
        // Apply a refused watch as discover() applies a refused account
        // listing: every kept receipt is dropped.
        this.listFailed(error)
        options.onRefused?.(error)
      },
      onTransportLost: () => this.transportLost(),
      onReachable: () => this.reachable(),
      onError: options.onError,
      onMode: options.onMode,
      logger: this.#logger,
      now: this.#now,
      setTimeoutImpl: this.#setTimeout,
      clearTimeoutImpl: this.#clearTimeout,
    })
    this.#watches.add(watch)
    watch.start()
    return {
      get mode() {
        return watch.mode
      },
      close: () => {
        this.#watches.delete(watch)
        watch.stop()
      },
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    if (this.#probeTimer) this.#clearTimeout(this.#probeTimer)
    this.#probeTimer = undefined
    for (const watch of this.#watches) watch.stop()
    this.#watches.clear()
    this.#kept.clear()
    this.#client.close()
  }

  /** Stop immediately; allow token reads 2 s and share an owner's timeout warning. */
  async dispose(onTimeout = this.#warnShutdown): Promise<void> {
    this.close()
    this.#disposing ??= drainShutdown(this.#tokenReads, onTimeout)
    await this.#disposing
  }
}
