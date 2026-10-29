export const NOW = Date.parse('2026-06-01T12:00:00Z')
const HOUR = 3_600_000

export interface WindowInput {
  usedPercent: number
  remainingPercent: number
  windowMinutes: number
  resetsAt: string
  checkedAt: number
}
export interface QuotaInput {
  checkedAt?: number
  primary?: WindowInput
  secondary?: WindowInput
  spendControl?: {
    limit: number
    used: number
    remaining: number
    usedPercent: number
    remainingPercent: number
    resetsAt: string
    reached: boolean
    unit: string
  }
  credits?: {
    hasCredits: boolean
    unlimited: boolean
    balance: number
    checkedAt: number
  }
}
export interface AccountInput {
  id: string
  label: string
  enabled: boolean
  killed: boolean
  quota: QuotaInput | null
  vaultState?: string
  resetCredits?: number
}
export interface FrameInput {
  name: string
  version: boolean
  pacing: boolean
  state: {
    lastUpdated: number
    main: { quota: null; killed: boolean }
    fallbacks: never[]
    vaultAccounts: AccountInput[]
    vaultDiscovered: boolean
    activeId: string
    route: 'main-first'
    planType?: string
  }
}

const window = (
  usedPercent: number,
  hours: number,
  windowMinutes = 300,
  checkedAt = NOW,
): WindowInput => ({
  usedPercent,
  remainingPercent: 100 - usedPercent,
  windowMinutes,
  resetsAt: new Date(NOW + hours * HOUR).toISOString(),
  checkedAt,
})
const account = (
  id: string,
  quota: QuotaInput | null,
  extra: Partial<AccountInput> = {},
): AccountInput => ({
  id,
  label: id,
  enabled: true,
  killed: false,
  quota,
  ...extra,
})
const frame = (
  name: string,
  accounts: AccountInput[],
  extra: Partial<FrameInput> = {},
): FrameInput => ({
  name,
  version: true,
  pacing: true,
  state: {
    lastUpdated: NOW,
    main: { quota: null, killed: false },
    fallbacks: [],
    vaultAccounts: accounts,
    vaultDiscovered: true,
    activeId: accounts[0]?.id ?? '',
    route: 'main-first',
  },
  ...extra,
})

export const cases: FrameInput[] = [
  frame('blocked-pace-long-stat', [
    account(
      'production-team@example.com',
      {
        checkedAt: NOW,
        primary: window(45, 1.5),
        secondary: window(70, 138, 10080),
        credits: {
          hasCredits: true,
          unlimited: false,
          balance: 1234.6,
          checkedAt: NOW,
        },
      },
      { killed: true, vaultState: 'auth needs attention', resetCredits: 2 },
    ),
  ]),
  frame('multiple-low-stale-empty-missing', [
    account('active-low', {
      checkedAt: NOW,
      primary: window(99.6, 2),
      secondary: window(0, 167, 10080),
    }),
    account(
      'stale-idle-long-account-name',
      { checkedAt: NOW - HOUR, primary: window(21, -0.5, 300, NOW - HOUR) },
      { killed: true, enabled: false },
    ),
    account('empty', { checkedAt: NOW }),
    account('missing', null),
  ]),
  frame(
    'credits-hidden-version',
    [
      account('budget-and-prepaid', {
        checkedAt: NOW,
        primary: window(100, 2),
        spendControl: {
          limit: 10000,
          used: 8000,
          remaining: 2000,
          usedPercent: 80,
          remainingPercent: 20,
          resetsAt: new Date(NOW + 24 * HOUR).toISOString(),
          reached: false,
          unit: 'credit',
        },
        credits: {
          hasCredits: true,
          unlimited: false,
          balance: 25,
          checkedAt: NOW,
        },
      }),
    ],
    { version: false, pacing: false },
  ),
  frame('no-accounts', []),
]

export const widths = [16, 36, 37, 42] as const
export const HEIGHT = 64
