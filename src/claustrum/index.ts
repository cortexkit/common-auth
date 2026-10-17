// Claustrum vault custody shared by the auth plugins: scoped enrollment (run
// from setup), discovery of this consumer's vault accounts as rows for this
// package's `/routing` subpath, per-send authorization, 401 reporting, the
// declined-account interlock and the host-slot guard. Needs the optional
// peer `@cortexkit/claustrum-client`.
import {
  ClaustrumClient,
  type ClaustrumClientOptions,
} from '@cortexkit/claustrum-client'
import type { ClaustrumScopedClient } from './custody.js'
import { insulaUsageTransport } from './insula.js'

export {
  ClaustrumCredentialError,
  type ClaustrumReporterSource,
  type EnrollmentTokenFile,
} from '@cortexkit/claustrum-client'
export {
  ClaustrumConsumer,
  type ClaustrumConsumerOptions,
  type SendOptions,
} from './consumer.js'
export {
  type AccountIdentitySource,
  type ClaustrumFamily,
  type ClaustrumScopedAttempt,
  type ClaustrumScopedClient,
  ClaustrumScopedCustody,
  type ClaustrumScopedIdentity,
  decideScopedRetryAfter401,
  type IdentityParser,
  isScopedCredentialRotation,
  type ScopedRetryReason,
  SERVING_MARGIN_MS,
  type SkippedVaultReason,
  type SkippedVaultRecord,
  type VaultCredential,
  type VaultCredentialType,
  type VaultGrantReach,
  type VaultGrantTuple,
  type VaultInventory,
} from './custody.js'
export {
  type ClaustrumEnrollmentClient,
  type ClaustrumEnrollmentConnection,
  type ClaustrumEnrollmentDisconnectResult,
  ClaustrumEnrollmentManager,
  type ClaustrumEnrollmentPaths,
  type ClaustrumEnrollmentResetResult,
  type ClaustrumEnrollmentStatus,
  classifyEnrollmentError,
  connectClaustrumEnrollmentClient,
  disconnectClaustrumEnrollment,
  type EnrollmentDisposition,
  enrollmentAuthority,
  enrollmentName,
  getClaustrumEnrollmentPaths,
  hostEnrollmentPaths,
  RETRYABLE_ENROLLMENT_CODES,
  readClaustrumEnrollmentStatus,
  readClaustrumEnrollmentToken,
  resetClaustrumEnrollmentState,
  TERMINAL_ENROLLMENT_CODES,
} from './enrollment.js'
export {
  ClaustrumConsumerError,
  type ClaustrumConsumerFailureKind,
  type ClaustrumLogger,
} from './errors.js'
export {
  assertHostSlotMatchesMode,
  assertNotCustodyPlaceholder,
  CUSTODY_PLACEHOLDER_PREFIX,
  classifyHostSlot,
  custodyPlaceholder,
  custodyPlaceholderKey,
  type HostSlotContent,
  isCustodyPlaceholder,
  isCustodyPlaceholderValue,
} from './host-slot.js'
export {
  acquireInsulaQuotaSource,
  type InsulaQuotaContext,
  type InsulaQuotaOptions,
  type InsulaQuotaSource,
  type InsulaUsageEntry,
  type InsulaUsageTransport,
  type InsulaUsageWindow,
} from './insula.js'
export {
  acceptAccount,
  type DeclinedAccount,
  declineAccount,
  isDeclined,
} from './interlock.js'
export {
  type AccountMapper,
  acceptVaultRoute,
  DEFAULT_ROUTE_PREFIX,
  declineVaultRoute,
  type MutateVaultRosterOptions,
  mutateVaultRoster,
  type ProjectionOptions,
  projectVaultRoster,
  type QuotaReceipt,
  readVaultRoster,
  recordVaultAccountQuota,
  recordVaultQuota,
  refreshVaultRoster,
  resolveVaultPrimary,
  type VaultPrimary,
  type VaultPrimaryBinding,
  type VaultPrimaryUnavailableReason,
  type VaultRosterFile,
  type VaultRosterLockContext,
  type VaultRosterRow,
  vaultRoutingRows,
} from './roster.js'

/**
 * Connect the client that lists and fetches this consumer's vault credentials
 * on the request path. `connectionFile` is required: this library
 * reads no environment, so the plugin resolves the vault's connection file.
 */
export async function connectClaustrumScopedClient(
  options: ClaustrumClientOptions & { connectionFile: string },
): Promise<ClaustrumScopedClient> {
  const client = await ClaustrumClient.connect(options)
  return Object.assign(client, { insula: insulaUsageTransport(options) })
}
