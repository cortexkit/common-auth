import assert from 'node:assert/strict'
import { projectQuota, quotaWindowParts } from '@cortexkit/common-auth/quota'
import {
  type AccountView,
  SidebarFrame,
  SidebarSection,
  SidebarStatRow,
  SidebarTextRow,
} from '@cortexkit/common-auth/quota-sidebar'
import { testRender } from '@opentui/solid'
import { createSignal } from 'solid-js'
import { NOW } from './cases.js'
import { appearance, theme } from './render-support.js'

const quota = projectQuota({
  limits: [
    {
      kind: 'reading',
      scope: 'all',
      label: 'short',
      usedPercent: 40,
      checkedAt: NOW,
      windowMinutes: 300,
    },
    {
      kind: 'reading',
      scope: 'all',
      label: 'long',
      usedPercent: 10,
      checkedAt: NOW,
      windowMinutes: 10080,
    },
  ],
})
const parts = quotaWindowParts(quota, { now: NOW }).windows
const [firstPart, secondPart] = parts
if (!firstPart || !secondPart) throw new Error('Expected two quota parts')
const account: AccountView = {
  id: 'one',
  label: 'account',
  titleSuffix: 'plan',
  status: { text: 'ready', tone: 'success' },
  blocked: false,
  indicatorTone: 'accent',
  quota,
  groups: [
    { title: 'First group', rows: [{ part: firstPart }] },
    { title: 'Second group', rows: [{ part: secondPart }] },
  ],
}
const [collapsed, setCollapsed] = createSignal(false)
const [accounts, setAccounts] = createSignal<readonly AccountView[]>([account])
const [showQuota, setShowQuota] = createSignal(true)
let storedCollapsed = false
let clicks = 0
const view = await testRender(
  () => (
    <SidebarFrame
      header={{ badge: 'TEST', version: 'v1' }}
      accounts={accounts()}
      theme={theme}
      appearance={appearance}
      now={NOW}
      showQuota={showQuota()}
      collapsed={collapsed()}
      onToggle={() => {
        clicks++
        storedCollapsed = !storedCollapsed
        setCollapsed(storedCollapsed)
      }}
      beforeQuota={() => (
        <SidebarTextRow text='before windows' tone='warning' />
      )}
      afterQuota={() => <SidebarTextRow text='after windows' />}
      sections={() => (
        <SidebarSection title='Custom'>
          <SidebarStatRow label='Choice' value='plugin value' />
        </SidebarSection>
      )}
    />
  ),
  { width: 42, height: 30 },
)
async function draw() {
  for (let pass = 0; pass < 3; pass++) await view.renderOnce()
  return view.captureCharFrame()
}
try {
  const expanded = await draw()
  assert.ok(expanded.includes('account · plan'))
  const ordered = [
    'before windows',
    'First group',
    '5h',
    'Second group',
    '7d',
    'after windows',
    'Custom',
    'plugin value',
  ]
  let previous = -1
  for (const text of ordered) {
    const at = expanded.indexOf(text)
    assert.ok(at > previous, `${text} missing or out of order`)
    previous = at
  }
  await view.mockMouse.click(3, 0)
  const compact = await draw()
  assert.equal(clicks, 1)
  assert.equal(storedCollapsed, true)
  assert.ok(compact.includes('▶ TEST'))
  assert.ok(compact.includes('5h 60% · 7d 90% left ●'))
  for (const hidden of [
    'plan',
    'First group',
    'before windows',
    'after windows',
    'Custom',
  ])
    assert.ok(
      !compact.includes(hidden),
      `${hidden} leaked into collapsed state`,
    )
  await view.mockMouse.click(3, 0)
  assert.equal(await draw(), expanded)
  assert.equal(storedCollapsed, false)
  setShowQuota(false)
  const hiddenQuota = await draw()
  assert.ok(!hiddenQuota.includes('before windows'))
  assert.ok(!hiddenQuota.includes('First group'))
  assert.ok(hiddenQuota.includes('Custom'))
  setAccounts([])
  setCollapsed(true)
  const empty = await draw()
  assert.ok(empty.includes('TEST'))
  assert.ok(!empty.includes('▶') && !empty.includes('▼'))
  assert.ok(empty.includes('Custom'))
  await view.mockMouse.click(3, 0)
  assert.equal(clicks, 2)
} finally {
  view.renderer.destroy()
}
console.log('sidebar groups, slots, controlled toggle and empty header passed')
