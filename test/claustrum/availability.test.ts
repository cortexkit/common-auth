import { expect, test } from 'bun:test'
import { ClaustrumCredentialError } from '@cortexkit/claustrum-client'
import {
  SocketClosedError,
  SocketTimeoutError,
  SubcCallError,
} from '@cortexkit/subc-client'
import {
  ClaustrumUnreachableError,
  classifyVaultFailure,
  VAULT_FAILURE_CLASSES,
} from '../../src/claustrum/index.ts'

const unreachable = [
  'ECONNREFUSED',
  'ENOENT',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'transport_error',
  'unavailable',
  'timeout',
  'route_closed',
  'daemon_draining',
  'connection_closed',
  'connection_dropped',
  'request_deadline',
  'deadline_exceeded_no_drop_observed',
  'module_reloading',
  'module_warming',
  'target_unavailable',
  'module_timeout',
  'unknown_channel',
  'stale_route_epoch',
]
const answered = [
  'invalid_response',
  'invalid_record_version',
  'invalid_expiry',
  'invalid_status',
  'invalid_params',
  'ttl_unsatisfiable',
  'not_found',
  'enrollment_revoked',
  'enrollment_invalid',
  'grant_denied',
  'credential_unavailable',
  'needs_reauth',
  'declined',
  'disabled',
  'identity_changed',
  'closed',
  'client_closed',
  'pending_exists',
  'pending_queue_full',
  'already_consumed',
  'superseded',
  'stale_generation',
  'missing_identity',
  'invalid_control_body',
  'unknown_module',
  'module_removed',
  'capability_denied',
  'capability_forbidden',
  'capability_unprovided',
  'capability_ambiguous',
  'invalid_capability_identifier',
  'binary_body_required',
  'binary_call_requires_call_binary',
  'corr_exhausted',
  'late_route_cleanup_failed',
  'reverse_request_capability_not_declared',
  'stale_route_handle',
  'reverse_request_unhandled',
  'handler_error',
  'health_error',
  'duplicate_module_id',
  'route_rejected',
  'lock_busy',
  'owner_invalid',
  'renewal_failed',
  'unsupported_platform',
  'EACCES',
  'EPERM',
  'ERR_PRIVATE_FILES_SECURITY',
]

test('vault failure table classifies every reviewed code and rejects unknown codes', () => {
  expect(Object.keys(VAULT_FAILURE_CLASSES).sort()).toEqual(
    [...unreachable, ...answered].sort(),
  )
  for (const [codes, expected] of [
    [unreachable, 'unreachable'],
    [answered, 'answered'],
  ] as const) {
    for (const code of codes) {
      expect(
        classifyVaultFailure(
          new ClaustrumCredentialError(code, 'transient', 'retry'),
        ),
      ).toBe(expected)
      expect(
        classifyVaultFailure(new SubcCallError('not_sent', 'not logged', code)),
      ).toBe(expected)
    }
  }
  for (const code of ['new_vault_code', 'toString', '__proto__', 'constructor'])
    expect(
      classifyVaultFailure(
        new ClaustrumCredentialError(code, 'transient', 'retry'),
      ),
    ).toBe('answered')
  expect(Object.isFrozen(VAULT_FAILURE_CLASSES)).toBe(true)
})

test('vault failure classification recognizes native connect failures but never arbitrary shutdowns', () => {
  expect(classifyVaultFailure(new ClaustrumUnreachableError())).toBe(
    'unreachable',
  )
  expect(new ClaustrumUnreachableError().kind).toBe('unavailable')
  expect(classifyVaultFailure(new SocketClosedError('socket ended'))).toBe(
    'unreachable',
  )
  expect(classifyVaultFailure(new SocketTimeoutError('connect deadline'))).toBe(
    'unreachable',
  )
  expect(
    classifyVaultFailure(
      Object.assign(new Error('connect'), { code: 'ENOENT' }),
    ),
  ).toBe('unreachable')
  expect(classifyVaultFailure(new Error('closed'))).toBe('answered')
  expect(classifyVaultFailure({ claustrumUnreachable: true })).toBe('answered')
  expect(classifyVaultFailure(undefined)).toBe('answered')
})
