import assert from 'node:assert/strict'
import { projectQuota, quotaWindowParts } from '@cortexkit/common-auth/quota'
import {
  type AccountView,
  SidebarFrame,
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
      resetsAt: new Date(NOW + 4 * 3_600_000).toISOString(),
    },
    {
      kind: 'reading',
      scope: 'all',
      label: 'long',
      usedPercent: 70,
      checkedAt: NOW,
      windowMinutes: 10080,
    },
  ],
})
const account: AccountView = {
  id: 'main',
  label: 'main',
  status: { text: 'active', tone: 'success' },
  blocked: false,
  indicatorTone: 'accent',
  quota,
  groups: [
    {
      rows: quotaWindowParts(quota, { now: NOW }).windows.map((part) => ({
        part,
      })),
    },
  ],
}
const [prefs, setPrefs] = createSignal(appearance)
const view = await testRender(
  () => (
    <SidebarFrame
      header={{ badge: 'TEST' }}
      accounts={[account]}
      theme={theme}
      appearance={prefs()}
      now={NOW}
      showQuota={true}
      collapsed={false}
      onToggle={() => {}}
    />
  ),
  { width: 60, height: 20 },
)
const phase = process.argv[2]
try {
  // Do not settle layout: hosts can paint immediately after mounting the frame.
  await view.renderOnce()
  if (phase === 'first-frame') {
    const frame = view.captureCharFrame()
    assert.match(frame, /5h ████░░░░░░ 60% left/, 'first frame lost the 5h bar')
    assert.match(frame, /7d ███████░░░ 30% left/, 'first frame lost the 7d bar')
    assert.match(frame, /60% left\s+4h/)
  } else if (phase === 'appearance') {
    setPrefs({
      barWidth: 15,
      barFilledChar: '#',
      barEmptyChar: '.',
      warnThreshold: 30,
      errorThreshold: 60,
    })
    await view.renderOnce()
    const frame = view.captureCharFrame()
    assert.match(frame, /5h ######\.\.\.\.\.\.\.\.\. 60% left/)
    assert.match(frame, /7d ###########\.\.\.\. 30% left/)
    const spans = view.captureSpans().lines.flatMap((line) => line.spans)
    for (const [text, tone] of [
      ['######.........', 'warning'],
      ['###########....', 'error'],
    ] as const) {
      const bar = spans.find((span) => span.text.includes(text))
      assert.ok(bar, `live appearance lost the ${tone} bar`)
      assert.deepEqual(bar.fg, theme[tone], `live ${tone} threshold colour`)
    }
    assert.doesNotMatch(frame, /█|░/)
  } else {
    throw new Error(`Unknown phase: ${phase}`)
  }
} finally {
  view.renderer.destroy()
}
console.log(`sidebar ${phase} frame passed`)
