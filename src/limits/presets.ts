import type {
  HostValues,
  LimitAxes,
  RefusalPolicy,
  UnknownLimitPolicy,
} from './axes.js'
import { ANTIGRAVITY_FAILURE_LADDER } from './marker.js'

function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child)
    Object.freeze(value)
  }
  return value
}

function hosts<T>(value: T): HostValues<T> {
  return { opencode1: value, opencode2: value, pi: value }
}

const reselect: UnknownLimitPolicy = {
  action: 'reselect',
  affinity: 'always',
  hint: 'none',
  defaultMs: 60000,
}
const sticky: UnknownLimitPolicy = {
  ...reselect,
  action: 'retain',
  affinity: 'sticky',
}
const auth: RefusalPolicy = {
  family: 'local-auth',
  messageKey: 'auth.no-account',
  retryable: false,
  hostRetry: 'leave',
}

function refusals(
  quota: RefusalPolicy,
  incomplete: RefusalPolicy,
): LimitAxes['refusals'] {
  return {
    auth: hosts(auth),
    quota: hosts(quota),
    incomplete: hosts(incomplete),
    'model-unavailable': hosts({
      family: 'json-412',
      messageKey: 'model-unavailable',
      retryable: false,
      hostRetry: 'veto',
    }),
  }
}

const off = { kind: 'off' } as const
const strict = { requestEscape: 'off', retryExhaustion: 'terminal' } as const
const noAdvance = { statuses: [], attributedLimitOnly: true } as const
const engineQuota: RefusalPolicy = {
  family: 'json-412',
  messageKey: 'quota.pool-exhausted',
  retryable: false,
  hostRetry: 'veto',
}

export const confirmedAffinity: LimitAxes = immutable<LimitAxes>({
  unconfirmedRetainLimit: 2,
  evidence: 'per-field-overlay',
  markers: hosts({
    kind: 'reset',
    mergeLaw: 'latest-evidence',
    defaultMs: 60000,
  }),
  readingClearsCoveredScopes: 'on',
  successClearsCoveredScopes: 'on',
  unknown: {
    opencode1: { ...reselect, action: 'retain', hint: 'minimum' },
    opencode2: reselect,
    pi: { ...reselect, action: 'pass' },
  },
  shortLimit: {
    holdBound: 'cache-ttl',
    preference: 'same-account-first',
    jitter: 'session-sha256',
  },
  retainBound: 'none',
  poolWaiting: off,
  execution: 'host',
  requestExclusion: 'off',
  advance: hosts(noAdvance),
  markedPool: strict,
  terminalMetadata: 'setting-capped-fresh',
  terminalPolicy: 'provided',
  refusals: refusals(
    {
      family: 'claude-429',
      messageKey: 'quota.all-accounts',
      retryable: true,
      hostRetry: 'leave',
    },
    {
      family: 'claude-econnreset',
      messageKey: 'incomplete.snapshot',
      retryable: true,
      hostRetry: 'leave',
    },
  ),
})

export const earliestPoolEngine: LimitAxes = immutable<LimitAxes>({
  evidence: 'typed',
  markers: hosts(ANTIGRAVITY_FAILURE_LADDER),
  readingClearsCoveredScopes: 'off',
  successClearsCoveredScopes: 'off',
  unknown: hosts(reselect),
  shortLimit: {
    holdBound: 'disabled',
    preference: 'ready-alternative-first',
    jitter: 'none',
  },
  retainBound: 'none',
  poolWaiting: {
    kind: 'earliest',
    budgetMs: 300000,
    requestDeadlineMs: 600000,
    hardFallbackMs: 60000,
    singleEligibleSoftExemption: true,
  },
  execution: 'engine',
  requestExclusion: 'on',
  advance: hosts({ statuses: [429, 503, 529], attributedLimitOnly: false }),
  markedPool: strict,
  terminalMetadata: 'baseline',
  terminalPolicy: 'pool',
  refusals: refusals(engineQuota, {
    ...engineQuota,
    messageKey: 'incomplete.timeout',
  }),
})

export const windowRouter: LimitAxes = immutable<LimitAxes>({
  evidence: 'named-window',
  markers: {
    opencode1: { kind: 'reset', mergeLaw: 'max-until', defaultMs: 60000 },
    opencode2: { kind: 'reset', mergeLaw: 'max-until', defaultMs: 60000 },
    pi: off,
  },
  readingClearsCoveredScopes: 'off',
  successClearsCoveredScopes: 'off',
  unknown: { opencode1: sticky, opencode2: reselect, pi: sticky },
  shortLimit: {
    holdBound: 'disabled',
    preference: 'ready-alternative-first',
    jitter: 'none',
  },
  retainBound: 'none',
  poolWaiting: off,
  execution: 'host',
  requestExclusion: 'off',
  advance: hosts({ statuses: [401, 403, 429], attributedLimitOnly: false }),
  markedPool: {
    requestEscape: 'ignore-timed-marks-if-all-marked',
    retryExhaustion: 'same-host-delay',
  },
  terminalMetadata: 'baseline',
  terminalPolicy: 'provided',
  refusals: refusals(
    {
      family: 'openai-429',
      messageKey: 'quota.no-route',
      retryable: true,
      hostRetry: 'leave',
    },
    {
      family: 'openai-429',
      messageKey: 'incomplete.snapshot',
      retryable: true,
      hostRetry: 'leave',
    },
  ),
})

export const statusVaultOrder: LimitAxes = immutable<LimitAxes>({
  evidence: 'hints-only',
  markers: {
    opencode1: {
      kind: 'hint',
      mergeLaw: 'overwrite',
      defaultMs: 60000,
      defaultMsByKind: { 'payment-balance': 300000 },
      causes: ['rate-limit', 'payment-balance'],
      ignoredKinds: ['payment-cap'],
      minimumMs: 0,
      zero: 'accept',
      hintClock: 'signal',
    },
    opencode2: {
      kind: 'hint',
      mergeLaw: 'overwrite',
      defaultMs: 60000,
      defaultMsByKind: { 'payment-balance': 300000 },
      causes: ['rate-limit', 'payment-balance'],
      ignoredKinds: ['payment-cap'],
      minimumMs: 0,
      zero: 'accept',
      hintClock: 'marker',
    },
    pi: {
      kind: 'hint',
      mergeLaw: 'overwrite',
      defaultMs: 60000,
      defaultMsByKind: { 'payment-balance': 300000 },
      causes: ['rate-limit', 'payment-balance'],
      ignoredKinds: ['payment-cap'],
      minimumMs: 0,
      zero: 'accept',
      hintClock: 'signal',
    },
  },
  readingClearsCoveredScopes: 'off',
  successClearsCoveredScopes: 'off',
  unknown: hosts(reselect),
  shortLimit: {
    holdBound: 'disabled',
    preference: 'ready-alternative-first',
    jitter: 'none',
  },
  retainBound: 'none',
  poolWaiting: off,
  execution: 'host',
  requestExclusion: 'off',
  advance: {
    opencode1: { statuses: [401, 429], attributedLimitOnly: false },
    opencode2: noAdvance,
    pi: { statuses: [401, 429], attributedLimitOnly: false },
  },
  markedPool: {
    requestEscape: 'ignore-timed-marks-if-all-marked',
    retryExhaustion: 'host-delay',
  },
  terminalMetadata: 'baseline',
  terminalPolicy: 'status-history',
  terminalStatusHistory: {
    minRetryMs: 1000,
    defaultRetryMs: 60000,
    paymentBalance: {
      family: 'claustrum-402',
      messageKey: 'payment.insufficient-balance',
    },
  },
  refusals: refusals(
    {
      family: 'claustrum-429',
      messageKey: 'quota.accounts-rate-limited',
      retryable: true,
      hostRetry: 'leave',
    },
    { ...auth, messageKey: 'incomplete.no-account' },
  ),
})

export const limitPresets = immutable({
  'confirmed-affinity': confirmedAffinity,
  'earliest-pool-engine': earliestPoolEngine,
  'window-router': windowRouter,
  'status-vault-order': statusVaultOrder,
})
