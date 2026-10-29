import {
  isQuotaStale,
  projectQuota,
  quotaWindowParts,
} from '@cortexkit/common-auth/quota'
import {
  type AccountView,
  type PaceView,
  SidebarFrame,
  SidebarSection,
  SidebarStatRow,
  SidebarTextRow,
  type Tone,
} from '@cortexkit/common-auth/quota-sidebar'
import { createSignal, Show } from 'solid-js'
import {
  type AccountInput,
  type FrameInput,
  NOW,
  type WindowInput,
} from './cases.js'
import { appearance, theme } from './render-support.js'

function pace(window: WindowInput): PaceView | undefined {
  const length = window.windowMinutes * 60_000
  const reset = Date.parse(window.resetsAt)
  const elapsed = NOW - (reset - length)
  if (elapsed < 300_000 || elapsed < length * 0.01 || elapsed >= length) return
  const percent = (elapsed / length) * 100
  const delta = window.usedPercent - percent
  if (Math.abs(delta) < 1) return
  const deficit = delta > 0
  const outIn = elapsed * (100 / window.usedPercent - 1)
  const minutes = Math.max(0, Math.floor(outIn / 60_000))
  const hours = Math.floor(minutes / 60)
  const duration =
    hours > 0
      ? `${hours}h${minutes % 60 > 0 ? `${minutes % 60}m` : ''}`
      : `${minutes}m`
  return {
    text: deficit
      ? `deficit ${Math.round(Math.abs(delta))}% · out in ${duration}`
      : `reserve ${Math.round(Math.abs(delta))}% · lasts`,
    tone: deficit ? 'warning' : 'textMuted',
    overlay: { kind: deficit ? 'deficit' : 'reserve', percent },
  }
}

function usageTone(used: number): Tone {
  return used >= appearance.errorThreshold
    ? 'error'
    : used >= appearance.warnThreshold
      ? 'warning'
      : 'success'
}

function accountView(
  account: AccountInput,
  index: number,
  input: FrameInput,
): AccountView {
  const raw = account.quota
  const quota = raw
    ? projectQuota({
        limits: (['primary', 'secondary'] as const).flatMap((label) => {
          const window = raw[label]
          return window
            ? [{ ...window, kind: 'reading' as const, scope: 'all', label }]
            : []
        }),
        ...(raw.spendControl
          ? {
              budget: {
                ...raw.spendControl,
                kind: 'reading' as const,
                checkedAt: raw.checkedAt ?? NOW,
              },
            }
          : {}),
      })
    : undefined
  const parts = quotaWindowParts(quota, { now: NOW }).windows
  const rows = parts.map((part) => {
    const window = [raw?.primary, raw?.secondary].find(
      (window) =>
        window && (window.windowMinutes === 300 ? '5h' : '7d') === part.name,
    )
    return { part, pace: input.pacing && window ? pace(window) : undefined }
  })
  const used = Math.max(
    raw?.primary?.usedPercent ?? 0,
    raw?.secondary?.usedPercent ?? 0,
  )
  let quotaTone: Tone = usageTone(used)
  if (
    rows.some((row) => row.pace?.overlay?.kind === 'deficit') &&
    quotaTone === 'success'
  )
    quotaTone = 'warning'
  const muted = index !== 0 || isQuotaStale(quota, { now: NOW })
  return {
    id: account.id,
    label: account.label,
    status: {
      text: account.killed ? 'blocked' : index === 0 ? 'active' : 'idle',
      tone: account.killed ? 'error' : index === 0 ? 'success' : 'textMuted',
    },
    blocked: account.killed,
    indicatorTone: account.killed ? 'error' : muted ? 'textMuted' : quotaTone,
    collapsed: { quotaTone, muted },
    quota,
    groups: [{ rows }],
    emptyQuotaText: {
      expanded: raw === null ? 'checking…' : '—',
      collapsed: '—',
    },
  }
}

// OpenAI owns credit metadata; unlike stats it preserves the value and cuts the label.
function CreditRow(props: { label: string; value: string }) {
  const [width, setWidth] = createSignal(0)
  let row: { width: number } | undefined
  const label = () => {
    const room = width() - Bun.stringWidth(props.value) - 1
    if (width() <= 0 || Bun.stringWidth(props.label) <= room) return props.label
    return room < 1 ? '' : `${props.label.slice(0, room - 1)}…`
  }
  return (
    <box
      ref={(element: { width: number }) => {
        row = element
      }}
      onSizeChange={() => setWidth(row?.width ?? 0)}
      width='100%'
      flexDirection='row'
      justifyContent='space-between'
    >
      <text fg={theme.textMuted} wrapMode='none' flexShrink={1}>
        {label()}
      </text>
      <text fg={theme.text} wrapMode='none' flexShrink={0}>
        <b>{props.value}</b>
      </text>
    </box>
  )
}

export function ParityFrame(props: {
  input: FrameInput
  collapsed: boolean
  onToggle?: () => void
}) {
  const input = props.input
  const accounts = input.state.vaultAccounts.map((account, index) =>
    accountView(account, index, input),
  )
  const killed = input.state.vaultAccounts
    .filter((account) => account.killed)
    .map((account) => account.label)
  return (
    <SidebarFrame
      header={{
        badge: 'OPENAI',
        version: input.version ? 'v1.8.4' : undefined,
      }}
      accounts={accounts}
      theme={theme}
      appearance={appearance}
      showQuota={true}
      now={NOW}
      collapsed={props.collapsed}
      onToggle={props.onToggle ?? (() => {})}
      beforeQuota={(account) => {
        const raw = input.state.vaultAccounts.find(
          (raw) => raw.id === account.id,
        )
        if (!raw) throw new Error(`Missing fixture account: ${account.id}`)
        return (
          <>
            <Show when={raw.vaultState}>
              <SidebarTextRow text={raw.vaultState ?? ''} tone='warning' />
            </Show>
            <Show when={!raw.enabled}>
              <SidebarTextRow text='off in /openai' />
            </Show>
          </>
        )
      }}
      afterQuota={(account) => {
        const raw = input.state.vaultAccounts.find(
          (raw) => raw.id === account.id,
        )
        if (!raw) throw new Error(`Missing fixture account: ${account.id}`)
        const budget = raw.quota?.spendControl
        const credits = raw.quota?.credits
        const serving = raw.quota?.primary?.usedPercent === 100
        return (
          <>
            <Show when={budget}>
              <CreditRow
                label='credits'
                value={`${Math.round(budget?.used ?? 0).toLocaleString('en-US')} / ${Math.round(budget?.limit ?? 0).toLocaleString('en-US')} credits`}
              />
            </Show>
            <Show when={credits}>
              <CreditRow
                label={serving ? 'serving on credits' : 'prepaid'}
                value={`${Math.round(credits?.balance ?? 0)} credits`}
              />
            </Show>
            <Show when={raw.resetCredits !== undefined}>
              <CreditRow label='resets' value={String(raw.resetCredits)} />
            </Show>
          </>
        )
      }}
      sections={() => (
        <>
          <Show when={accounts.length === 0}>
            <box marginTop={1} width='100%'>
              <SidebarTextRow text='No vault accounts' />
            </box>
          </Show>
          <SidebarSection title='Routing'>
            <SidebarStatRow label='Route' value='main-first' tone='accent' />
          </SidebarSection>
          <Show when={killed.length > 0}>
            <SidebarSection title='Health' />
          </Show>
          <Show when={killed.length > 0}>
            <SidebarStatRow
              label='Killswitch'
              value={`${killed.join(', ')} blocked`}
              tone='error'
            />
          </Show>
        </>
      )}
    />
  )
}
