import assert from 'node:assert/strict'
import {
  type ProjectedQuota,
  projectQuota,
  quotaWindowParts,
} from '@cortexkit/common-auth/quota'
import {
  type AccountView,
  SidebarFrame,
  SidebarTextRow,
} from '@cortexkit/common-auth/quota-sidebar'
import { testRender } from '@opentui/solid'
import { createSignal } from 'solid-js'
import { NOW } from './cases.js'
import { appearance, theme } from './render-support.js'

const [now, setNow] = createSignal(NOW)
const [quota, setQuota] = createSignal<ProjectedQuota>()
const [collapsed, setCollapsed] = createSignal(true)
const account: AccountView = {
  id: 'main',
  label: 'main',
  status: { text: 'active', tone: 'success' },
  blocked: false,
  indicatorTone: 'accent',
  get quota() {
    return quota()
  },
  get groups() {
    return [
      {
        rows: quotaWindowParts(quota(), { now: now() }).windows.map((part) => ({
          part,
        })),
      },
    ]
  },
  emptyQuotaText: { expanded: 'no reading', collapsed: 'waiting' },
}
let before = 0
let after = 0
const view = await testRender(
  () => (
    <SidebarFrame
      header={{ badge: 'TEST' }}
      accounts={[account]}
      theme={theme}
      appearance={appearance}
      now={now()}
      showQuota={true}
      collapsed={collapsed()}
      onToggle={() => {}}
      beforeQuota={(source) => {
        assert.equal(source, account)
        assert.equal(source.quota, quota())
        before++
        return <SidebarTextRow text='before quota' />
      }}
      afterQuota={(source) => {
        assert.equal(source, account)
        assert.equal(source.quota, quota())
        after++
        return <SidebarTextRow text='after quota' />
      }}
    />
  ),
  { width: 60, height: 16 },
)

async function frame() {
  for (let pass = 0; pass < 3; pass++) await view.renderOnce()
  return view.captureCharFrame()
}

try {
  assert.match(await frame(), /waiting/)
  setQuota(
    projectQuota({
      limits: [
        {
          kind: 'reading',
          scope: 'all',
          label: 'short',
          usedPercent: 40,
          checkedAt: NOW,
          windowMinutes: 300,
          resetsAt: new Date(NOW + 4 * 3_600_000).toISOString(),
        },
      ],
    }),
  )
  assert.match(await frame(), /60%/)
  assert.doesNotMatch(await frame(), /waiting/)
  setCollapsed(false)
  await frame()
  assert.ok(
    before > 0 && after > 0,
    'expanded slots must receive original accounts',
  )
  setNow(NOW + 20 * 60_000)
  assert.match(await frame(), /checked 20m ago/)
  setQuota(undefined)
  assert.doesNotMatch(await frame(), /checked 20m ago/)
  setCollapsed(true)
  assert.match(await frame(), /waiting/)
} finally {
  view.renderer.destroy()
}
console.log('quota adapter clock, quota and slot identity passed')
