import type { RGBA } from '@opentui/core'
import type { JSX } from '@opentui/solid'
import {
  createContext,
  createMemo,
  createSignal,
  For,
  Show,
  useContext,
} from 'solid-js'
import type { QuotaWindowPart } from '../quota/format.js'
import { formatQuota, quotaWindowParts } from '../quota/format.js'
import type { ProjectedQuota } from '../quota/projection.js'

export type Tone =
  | 'text'
  | 'textMuted'
  | 'accent'
  | 'success'
  | 'warning'
  | 'error'

export type SidebarTheme = Readonly<
  Record<Tone | 'background' | 'borderActive', RGBA>
>

export interface SidebarAppearance {
  barWidth: number
  barFilledChar: string
  barEmptyChar: string
  warnThreshold: number
  errorThreshold: number
}

export interface PaceView {
  text: string
  tone: Tone
  /** The elapsed-window percentage, not the difference from usage. */
  overlay?: { kind: 'reserve' | 'deficit'; percent: number }
}

export interface QuotaGroupView {
  title?: string
  rows: readonly { part: QuotaWindowPart; pace?: PaceView }[]
}

export interface AccountView {
  id: string
  label: string
  titleSuffix?: string
  status: { text: string; tone: Tone }
  blocked: boolean
  indicatorTone: Tone
  quota: ProjectedQuota | undefined
  groups: readonly QuotaGroupView[]
  emptyQuotaText?: { expanded: string; collapsed: string }
  /** Presentation decided by the plugin, never inferred from status or freshness. */
  collapsed?: { quotaTone?: Tone; muted?: boolean }
}

export interface SidebarFrameProps {
  header: { badge: string; version?: string }
  accounts: readonly AccountView[]
  theme: SidebarTheme
  appearance: SidebarAppearance
  showQuota: boolean
  now: number
  collapsed: boolean
  onToggle: () => void
  beforeQuota?: (account: AccountView) => JSX.Element
  afterQuota?: (account: AccountView) => JSX.Element
  sections?: () => JSX.Element
}

const FrameContext = createContext<SidebarFrameProps>()

function frameContext(): SidebarFrameProps {
  const context = useContext(FrameContext)
  if (!context)
    throw new Error('Sidebar primitives must be inside SidebarFrame')
  return context
}

function displayWidth(text: string): number {
  const bun = (
    globalThis as { Bun?: { stringWidth?: (text: string) => number } }
  ).Bun
  return bun?.stringWidth ? bun.stringWidth(text) : Array.from(text).length
}

function fitText(text: string, columns: number): string {
  if (displayWidth(text) <= columns) return text
  if (columns < 1) return ''
  let kept = ''
  let used = 0
  for (const char of text) {
    const width = displayWidth(char)
    if (used + width > columns - 1) break
    kept += char
    used += width
  }
  return `${kept}\u2026`
}

/** A heading and its plugin-owned rows, with the frame's section spacing. */
export function SidebarSection(props: {
  title: string
  children?: JSX.Element
}) {
  const context = frameContext()
  return (
    <>
      <box width='100%' marginTop={1}>
        <text fg={context.theme.text}>
          <b>{props.title}</b>
        </text>
      </box>
      {props.children}
    </>
  )
}

/** Keep labels whole and reserve one blank cell before an ellipsized value. */
export function SidebarStatRow(props: {
  label: string
  value: string
  tone?: Tone
}) {
  const context = frameContext()
  const [width, setWidth] = createSignal(0)
  let row: { width: number } | undefined
  const value = () =>
    width() <= 0
      ? props.value
      : fitText(props.value, width() - displayWidth(props.label) - 1)
  return (
    <box
      ref={(element: { width: number }) => {
        row = element
      }}
      onSizeChange={() => setWidth(row?.width ?? 0)}
      width='100%'
      flexDirection='row'
      justifyContent='space-between'
      columnGap={1}
    >
      <text fg={context.theme.textMuted} wrapMode='none' flexShrink={0}>
        {props.label}
      </text>
      <text
        fg={context.theme[props.tone ?? 'text']}
        wrapMode='none'
        flexShrink={1}
      >
        <b>{value()}</b>
      </text>
    </box>
  )
}

export function SidebarTextRow(props: { text: string; tone?: Tone }) {
  const context = frameContext()
  return <text fg={context.theme[props.tone ?? 'textMuted']}>{props.text}</text>
}

function usageTone(used: number, appearance: SidebarAppearance): Tone {
  if (used >= appearance.errorThreshold) return 'error'
  if (used >= appearance.warnThreshold) return 'warning'
  return 'success'
}

function barSegments(
  used: number,
  appearance: SidebarAppearance,
  pace?: PaceView,
) {
  const width = appearance.barWidth
  const cells = (pct: number) =>
    Math.max(0, Math.min(Math.round((pct / 100) * width), width))
  const usedCells = cells(used)
  const tone = usageTone(used, appearance)
  const plain = [
    { text: appearance.barFilledChar.repeat(usedCells), tone },
    { text: appearance.barEmptyChar.repeat(width - usedCells), tone },
  ]
  const overlay = pace?.overlay
  if (!overlay) return plain.filter((segment) => segment.text.length > 0)
  const paceCells = cells(overlay.percent)
  const lo = Math.min(usedCells, paceCells)
  const hi = Math.max(usedCells, paceCells)
  if (lo === hi) return plain.filter((segment) => segment.text.length > 0)
  return [
    { text: appearance.barFilledChar.repeat(lo), tone },
    {
      text: (overlay.kind === 'deficit' ? '\u2593' : '\u2592').repeat(hi - lo),
      tone:
        overlay.kind === 'deficit' ? ('error' as const) : ('success' as const),
    },
    { text: appearance.barEmptyChar.repeat(width - hi), tone },
  ].filter((segment) => segment.text.length > 0)
}

function QuotaRow(props: {
  part: QuotaWindowPart
  pace?: PaceView
  labelWidth: number
}) {
  const context = frameContext()
  const [columns, setColumns] = createSignal(0)
  let row: { width: number } | undefined
  const label = () => props.part.name.padEnd(props.labelWidth)
  const figure = () =>
    ` ${props.part.kind === 'budget' && props.part.figure.startsWith(`${props.part.name} `) ? props.part.figure.slice(props.part.name.length + 1) : props.part.figure}`
  const reset = () =>
    props.part.resetIn ?? (props.part.resetSinceReading ? 'reset' : undefined)
  const used = () => 100 - (props.part.remainingPercent ?? 100)
  const fit = () => {
    const barWidth = context.appearance.barWidth
    const resetWidth = displayWidth(reset() ?? '')
    if (columns() <= 0) return { barCells: barWidth, showReset: resetWidth > 0 }
    const fixed = displayWidth(label()) + displayWidth(figure())
    if (resetWidth > 0 && fixed + barWidth + 1 + resetWidth <= columns())
      return { barCells: barWidth, showReset: true }
    const room = columns() - fixed
    return {
      barCells: room >= barWidth ? barWidth : room >= 3 ? room : 0,
      showReset: false,
    }
  }
  // Stable fits keep existing bar nodes alive through the first measurement.
  const barCells = createMemo(() => fit().barCells)
  const showReset = createMemo(() => fit().showReset)
  const paceLine = () => {
    const text = props.pace?.text
    if (!text || columns() <= 0) return text
    return fitText(text, columns() - props.labelWidth)
  }
  return (
    <>
      <box
        ref={(element: { width: number }) => {
          row = element
        }}
        onSizeChange={() => setColumns(row?.width ?? 0)}
        width='100%'
        flexDirection='row'
        justifyContent='space-between'
      >
        <box flexDirection='row' flexShrink={0}>
          <text fg={context.theme.textMuted} wrapMode='none'>
            {label()}
          </text>
          <For
            each={barSegments(
              used(),
              { ...context.appearance, barWidth: barCells() },
              props.pace,
            )}
          >
            {(segment) => (
              <text fg={context.theme[segment.tone]} wrapMode='none'>
                {segment.text}
              </text>
            )}
          </For>
          <text
            fg={context.theme[usageTone(used(), context.appearance)]}
            wrapMode='none'
          >
            {figure()}
          </text>
        </box>
        <Show when={showReset()}>
          <text fg={context.theme.textMuted} wrapMode='none' flexShrink={0}>
            {reset()}
          </text>
        </Show>
      </box>
      {/* A changed fitted line needs a fresh text node to draw at its new width. */}
      <Show when={paceLine()} keyed>
        {(line: string) => (
          <box width='100%' flexDirection='row'>
            <text fg={context.theme.textMuted}>
              {''.padEnd(props.labelWidth)}
            </text>
            <text
              fg={context.theme[props.pace?.tone ?? 'textMuted']}
              wrapMode='none'
            >
              {line}
            </text>
          </box>
        )}
      </Show>
    </>
  )
}

function CollapsedAccountRow(props: { account: AccountView }) {
  const context = frameContext()
  const [width, setWidth] = createSignal(0)
  let row: { width: number } | undefined
  const hasQuota = () =>
    quotaWindowParts(props.account.quota, { now: context.now }).windows.length >
    0
  const text = () =>
    hasQuota()
      ? formatQuota(props.account.quota, { now: context.now, form: 'narrow' })
      : null
  const label = () => {
    if (width() <= 0) return props.account.label
    const value =
      text() === null
        ? displayWidth(props.account.emptyQuotaText?.collapsed ?? '\u2014')
        : displayWidth(text() ?? '') + 2
    return fitText(props.account.label, width() - value - 1)
  }
  const muted = () => props.account.collapsed?.muted ?? false
  const quotaTone = () =>
    muted() ? 'textMuted' : (props.account.collapsed?.quotaTone ?? 'success')
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
      <text
        fg={context.theme[muted() ? 'textMuted' : 'text']}
        wrapMode='none'
        flexShrink={1}
      >
        {label()}
      </text>
      <Show
        when={text() !== null}
        fallback={
          <text fg={context.theme.textMuted}>
            {props.account.emptyQuotaText?.collapsed ?? '\u2014'}
          </text>
        }
      >
        <box flexDirection='row' flexShrink={0}>
          <Show
            when={!muted()}
            fallback={<text fg={context.theme.textMuted}>{text()}</text>}
          >
            <text fg={context.theme[quotaTone()]}>
              <b>{text()}</b>
            </text>
          </Show>
          <text fg={context.theme[props.account.indicatorTone]}>
            {props.account.blocked ? ' \u2298' : ' \u25cf'}
          </text>
        </box>
      </Show>
    </box>
  )
}

function AccountBlock(props: {
  account: AccountView
  labelWidth: number
  marginTop: number
}) {
  const context = frameContext()
  const age = () =>
    quotaWindowParts(props.account.quota, { now: context.now }).age
  const hasRows = () =>
    props.account.groups.some((group) => group.rows.length > 0)
  return (
    <box width='100%' flexDirection='column' marginTop={props.marginTop}>
      <box width='100%' flexDirection='row' justifyContent='space-between'>
        <text fg={context.theme.text}>
          <b>
            {props.account.label}
            {props.account.titleSuffix ? ` · ${props.account.titleSuffix}` : ''}
          </b>
        </text>
        <text fg={context.theme[props.account.status.tone]}>
          <b>{props.account.status.text}</b>
        </text>
      </box>
      {context.beforeQuota?.(props.account)}
      <Show
        when={hasRows()}
        fallback={
          <SidebarTextRow
            text={props.account.emptyQuotaText?.expanded ?? '\u2014'}
          />
        }
      >
        <For each={props.account.groups}>
          {(group) => (
            <>
              <Show when={group.title}>
                <SidebarTextRow text={group.title ?? ''} tone='text' />
              </Show>
              <For each={group.rows}>
                {(row) => (
                  <QuotaRow
                    part={row.part}
                    pace={row.pace}
                    labelWidth={props.labelWidth}
                  />
                )}
              </For>
            </>
          )}
        </For>
      </Show>
      <Show when={age()}>
        {(text: () => string) => <SidebarTextRow text={text()} />}
      </Show>
      {context.afterQuota?.(props.account)}
    </box>
  )
}

/** Borderless, controlled presentation; host registration and provider policy stay in the plugin. */
export function SidebarFrame(props: SidebarFrameProps) {
  const hasData = () => props.accounts.length > 0
  const headerLabel = () =>
    !hasData()
      ? props.header.badge
      : `${props.collapsed ? '\u25b6' : '\u25bc'} ${props.header.badge}`
  const labelWidth = () =>
    Math.max(
      3,
      ...props.accounts.flatMap((account) =>
        account.groups.flatMap((group) =>
          group.rows.map((row) => row.part.name.length + 1),
        ),
      ),
    )
  return (
    <FrameContext.Provider value={props}>
      <box
        width='100%'
        flexDirection='column'
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={1}
        paddingRight={1}
      >
        {/* Blocked accounts retain their own indicators; the header always keeps its version. */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI terminal widgets do not have DOM roles */}
        <box
          width='100%'
          flexDirection='row'
          justifyContent='space-between'
          alignItems='center'
          onMouseDown={() => {
            if (hasData()) props.onToggle()
          }}
        >
          <box
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={props.theme.accent}
          >
            <text fg={props.theme.background}>
              <b>{headerLabel()}</b>
            </text>
          </box>
          <Show when={props.header.version}>
            <text fg={props.theme.textMuted}>{props.header.version}</text>
          </Show>
        </box>
        <Show when={props.collapsed && hasData()}>
          <For each={props.accounts}>
            {(account) => <CollapsedAccountRow account={account} />}
          </For>
        </Show>
        <Show when={!props.collapsed || !hasData()}>
          <Show when={props.showQuota && hasData()}>
            <SidebarSection title='Quota'>
              <For each={props.accounts}>
                {(account, index) => (
                  <AccountBlock
                    account={account}
                    labelWidth={labelWidth()}
                    marginTop={index() === 0 ? 0 : 1}
                  />
                )}
              </For>
            </SidebarSection>
          </Show>
          {props.sections?.()}
        </Show>
      </box>
    </FrameContext.Provider>
  )
}
