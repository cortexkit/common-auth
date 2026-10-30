import assert from 'node:assert/strict'
import { projectQuota, quotaWindowParts } from '@cortexkit/common-auth/quota'
import {
  type AccountView,
  type SidebarAppearance,
  SidebarFrame,
  type SidebarTheme,
} from '@cortexkit/common-auth/quota-sidebar'
import { testRender } from '@opentui/solid'
import { createSignal } from 'solid-js'
import { NOW } from './cases.js'
import { appearance, theme } from './render-support.js'

const phase = process.argv[2]
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
      rows: quotaWindowParts(quota, { now: NOW }).windows.map(
        (part, index) => ({
          part,
          pace:
            phase === 'theme' && index === 0
              ? {
                  text: '',
                  tone: 'error',
                  overlay: { kind: 'deficit', percent: 60 },
                }
              : undefined,
        }),
      ),
    },
  ],
}
const [prefs, setPrefs] = createSignal(appearance)
const [palette, setPalette] = createSignal<SidebarTheme>(theme)
function mountSidebar(
  palette: () => SidebarTheme,
  prefs: () => SidebarAppearance,
  onMount = () => {},
) {
  return testRender(
    () => {
      onMount()
      return (
        <SidebarFrame
          header={{ badge: 'TEST' }}
          accounts={[account]}
          theme={palette()}
          appearance={prefs()}
          now={NOW}
          showQuota={true}
          collapsed={false}
          onToggle={() => {}}
        />
      )
    },
    { width: 60, height: 20 },
  )
}
let mounts = 0
const view = await mountSidebar(palette, prefs, () => mounts++)
async function snapshot(view: Awaited<ReturnType<typeof mountSidebar>>) {
  for (let pass = 0; pass < 3; pass++) await view.renderOnce()
  return {
    chars: view.captureCharFrame(),
    glyphs: view
      .captureSpans()
      .lines.flatMap((line) =>
        line.spans.flatMap((span) =>
          [...span.text]
            .filter((char) => /[█░▓▒]/u.test(char))
            .map((char) => ({ char, fg: span.fg })),
        ),
      ),
  }
}
async function matchesFresh(label: string) {
  const actual = await snapshot(view)
  const fresh = await mountSidebar(palette, prefs)
  try {
    const expected = await snapshot(fresh)
    assert.equal(actual.chars, expected.chars, `${label}: text`)
    assert.deepEqual(
      actual.glyphs,
      expected.glyphs,
      `${label}: bar foregrounds`,
    )
    assert.equal(mounts, 1, `${label}: live frame must stay on one mount`)
    return actual
  } finally {
    fresh.renderer.destroy()
  }
}
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
  } else if (phase === 'theme') {
    for (const [label, next] of [
      ['full theme', theme],
      ['cleared theme', {}],
      ['restored theme', theme],
    ] as const) {
      setPalette(next)
      const actual = await matchesFresh(label)
      assert.equal(actual.glyphs.length, 20, `${label}: all bar glyphs present`)
      assert.ok(actual.glyphs.some(({ char }) => char === '▓'))
    }
  } else if (phase === 'width') {
    const before = await matchesFresh('width 10')
    assert.equal(before.glyphs.length, 20)
    setPrefs({ ...appearance, barWidth: 40 })
    const after = await matchesFresh('width 40')
    assert.equal(after.glyphs.length, 80)
    assert.notEqual(after.chars, before.chars)
  } else {
    throw new Error(`Unknown phase: ${phase}`)
  }
} finally {
  view.renderer.destroy()
}
console.log(`sidebar ${phase} frame passed`)
