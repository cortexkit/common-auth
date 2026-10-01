import {
  type ClaustrumClient,
  ClaustrumCredentialError,
  type ClaustrumReporterSource,
  type EnrollmentTokenFile,
  type ScopedInventoryRow,
} from '@cortexkit/claustrum-client'
import { createLogger } from '../logger/index.js'
import { readClaustrumEnrollmentToken } from './enrollment.js'
import { ClaustrumConsumerError, type ClaustrumLogger } from './errors.js'
import { CUSTODY_PLACEHOLDER_PREFIX } from './host-slot.js'

export type ClaustrumScopedClient = Pick<
  ClaustrumClient,
  'listScoped' | 'getScoped' | 'reportAuthFailureScoped' | 'close'
>

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

/** One vault credential this consumer may serve. Never carries bearer material. */
export interface VaultCredential {
  readonly credentialId: string
  readonly credentialType: VaultCredentialType
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
  readonly reason: SkippedVaultReason
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
   * Kept in memory only and hidden from JSON.stringify and object spreads, so
   * logging a receipt never leaks it. Authorize again for every dispatch and retry.
   */
  readonly accessToken: string
  readonly recordVersion: number
  readonly expiresAtMs: number | null
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

function credentialTypeOf(
  row: ScopedInventoryRow,
  family: ClaustrumFamily,
): VaultCredentialType | undefined {
  if (!row.operations.includes('read')) return undefined
  if (!row.categories.includes(family.category)) return undefined
  if (row.credentialType === 'oauth')
    return row.refreshAdapter === family.refreshAdapter ? 'oauth' : undefined
  if (row.credentialType === 'api_key' && family.apiKeys)
    return row.refreshAdapter === undefined ? 'api_key' : undefined
  return undefined
}

/**
 * Reads this consumer's vault credentials (list, fetch, 401 report), with the
 * enrollment token as authorization. Used by every host of a plugin. There is
 * deliberately no credential cache and no single-flight of credential reads:
 * each physical send is authorized by the vault, so a revoked enrollment or a
 * changed record takes effect on the next send. The enrollment token is
 * re-read per operation so an operator's reissue on disk is picked up.
 */
export class ClaustrumScopedCustody {
  readonly #client: ClaustrumScopedClient
  readonly #readToken: () => Promise<EnrollmentTokenFile>
  readonly #now: () => number
  readonly #family: ClaustrumFamily
  readonly #parseIdentity?: IdentityParser
  readonly #requireAssertion: boolean
  readonly #logger: ClaustrumLogger
  readonly #provenance = new WeakMap<ClaustrumScopedAttempt, string>()
  readonly #reports = new WeakMap<ClaustrumScopedAttempt, Promise<void>>()
  #closed = false

  constructor(options: {
    client: ClaustrumScopedClient
    family: ClaustrumFamily
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
    const value = await this.#readToken()
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
      // Keep the vault's own refusals (ClaustrumCredentialError, carrying
      // code, class and action); replace any other error, whose text may echo
      // request params that include the enrollment token.
      if (error instanceof ClaustrumCredentialError) throw error
      throw new ClaustrumConsumerError(
        'unavailable',
        'Claustrum scoped operation unavailable',
      )
    } finally {
      removeAbortListener?.()
    }
    this.#check(signal)
    return result
  }

  /**
   * List this consumer's credentials. A record that cannot be used is skipped
   * and warned about rather than failing the whole list, so one bad record
   * never hides every other account. Records outside the family are not
   * skipped records: they simply are not this consumer's.
   */
  async discover(signal?: AbortSignal): Promise<VaultInventory> {
    const token = await this.#token(signal)
    const inventory = await this.#call(
      () => this.#client.listScoped(token),
      signal,
    )
    const skipped: SkippedVaultRecord[] = []
    const candidates: Array<{
      row: ScopedInventoryRow
      type: VaultCredentialType
    }> = []
    const counts = new Map<string, number>()
    for (const row of inventory.rows) {
      const type = credentialTypeOf(row, this.#family)
      if (!type) continue
      candidates.push({ row, type })
      counts.set(row.id, (counts.get(row.id) ?? 0) + 1)
    }
    const credentials: VaultCredential[] = []
    for (const { row, type } of candidates) {
      let reason: SkippedVaultReason | undefined
      if (!row.id.trim()) reason = 'empty credential id'
      else if ((counts.get(row.id) ?? 0) > 1) reason = 'duplicate credential id'
      else if (row.accountId !== undefined && !row.accountId.trim())
        reason = 'blank account identity'
      else if (!row.state.trim()) reason = 'empty state'
      if (reason) {
        skipped.push({ ...(row.id.trim() && { credentialId: row.id }), reason })
        continue
      }
      credentials.push(
        Object.freeze({
          credentialId: row.id,
          credentialType: type,
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
    return {
      view: inventory.view,
      credentials: Object.freeze(credentials),
      skipped: Object.freeze(skipped),
    }
  }

  /**
   * Fetch the credential for one physical send and wrap it in a fresh receipt.
   * The vault's served identity (or, without one, the plugin's parse of the
   * token) must equal the roster's when both are present. Without
   * `requireAssertion`, absence on either side proves nothing and does not
   * refuse; the receipt records what the vault asserted separately from what
   * the roster expected. With it, a reply that does not itself name the
   * credential id and the expected account is refused.
   */
  async authorize(
    identity: ClaustrumScopedIdentity,
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
    const token = await this.#token(signal)
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

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#client.close()
  }
}
