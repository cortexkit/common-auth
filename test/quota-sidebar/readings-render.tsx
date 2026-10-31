import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  type ProjectedLimit,
  type ProjectedQuota,
  quotaWindowParts,
} from '@cortexkit/common-auth/quota'
import {
  type AccountView,
  SidebarFrame,
} from '@cortexkit/common-auth/quota-sidebar'
import { NOW } from './cases.js'
import { appearance, capture, theme } from './render-support.js'

const limit = (
  label: string,
  windowMinutes: number,
  remainingPercent?: number,
): ProjectedLimit => ({
  kind: 'reading',
  scope: 'fable',
  label,
  windowMinutes,
  remainingPercent,
  checkedAt: NOW,
  resetsAt: new Date(NOW + 7_200_000).toISOString(),
})
const inputs = [
  {
    name: 'mixed-readings',
    limits: [limit('5h', 300, 75), limit('7d', 10080)],
  },
  { name: 'all-no-reading', limits: [limit('5h', 300), limit('7d', 10080)] },
  { name: 'fully-used', limits: [limit('5h', 300, 0)] },
]
function account(limits: ProjectedLimit[]): AccountView {
  const quota: ProjectedQuota = {
    scope: 'all',
    limits,
    groups: [{ scope: 'fable', label: 'Fable' }],
  }
  return {
    id: 'one',
    label: 'account',
    status: { text: 'ready', tone: 'success' },
    blocked: false,
    indicatorTone: 'accent',
    quota,
    groups: [
      {
        title: 'Fable',
        rows: quotaWindowParts(quota, { now: NOW }).windows.map((part) => ({
          part,
        })),
      },
    ],
  }
}
async function draw(value: AccountView, collapsed = false, width = 42) {
  return capture(
    () => (
      <SidebarFrame
        header={{ badge: 'TEST', version: 'v1' }}
        accounts={[value]}
        theme={theme}
        appearance={appearance}
        now={NOW}
        showQuota={true}
        collapsed={collapsed}
        onToggle={() => {}}
      />
    ),
    width,
  )
}
let checked = 0
for (const input of inputs) {
  for (const collapsed of [false, true]) {
    const actual = await draw(account(input.limits), collapsed)
    const lines = actual.chars.split('\n').map((line) => line.trim())
    if (!collapsed && input.name !== 'fully-used') {
      assert.ok(
        lines.includes('7d no reading'),
        `missing no reading row\n${actual.chars}`,
      )
      if (input.name === 'all-no-reading') {
        assert.ok(lines.includes('Fable') && lines.includes('5h no reading'))
        assert.ok(!/[█░%]/u.test(actual.chars) && !actual.chars.includes('2h'))
      }
      for (const line of actual.spans.lines.filter((line) =>
        line.spans.some((span) => span.text.includes('no reading')),
      )) {
        for (const span of line.spans.filter((span) => span.text.trim())) {
          assert.deepEqual(span.fg, theme.textMuted, 'no reading row is muted')
        }
      }
    }
    if (!collapsed && input.name === 'fully-used') {
      assert.ok(
        lines.some(
          (line) =>
            line.startsWith('5h ██████████ 0% left') && line.endsWith('2h'),
        ),
      )
      const figure = actual.spans.lines
        .flatMap((line) => line.spans)
        .find((span) => span.text.includes('0% left'))
      assert.deepEqual(figure?.fg, theme.error)
    }
    if (collapsed) {
      assert.ok(
        !actual.chars.includes('no reading') && !actual.chars.includes('7d'),
      )
      if (input.name === 'mixed-readings')
        assert.ok(actual.chars.includes('Fa 5h 75% left ●'))
      if (input.name === 'all-no-reading')
        assert.ok(lines.some((line) => /^account +— ●$/u.test(line)))
    }
    const key = `${input.name}-${collapsed ? 'collapsed' : 'expanded'}-42`
    assert.deepEqual(
      Buffer.from(actual.chars),
      await readFile(new URL(`./goldens/${key}.txt`, import.meta.url)),
      `${key}: raw UTF-8 frame`,
    )
    assert.deepEqual(
      Buffer.from(`${JSON.stringify(actual.spans)}\n`),
      await readFile(new URL(`./goldens/${key}.spans`, import.meta.url)),
      `${key}: style spans`,
    )
    checked++
  }
}

// An unknown state suppresses leftover figures, resets and pace in composed parts.
const value = account([limit('5h', 300, 75)])
const part = value.groups[0]?.rows[0]?.part
if (!part) throw new Error('Expected a reported part')
for (const width of [16, 42]) {
  for (const name of ['', '5h']) {
    const actual = await draw(
      {
        ...value,
        groups: [
          {
            rows: [
              {
                part: { ...part, name, reading: 'unknown' as const },
                pace: { text: 'old pace', tone: 'warning' },
              },
            ],
          },
        ],
      },
      false,
      width,
    )
    assert.ok(
      actual.chars
        .split('\n')
        .some((line) => line.trim() === `${name ? `${name} ` : ''}no reading`),
    )
    assert.ok(
      !/[█░%]/u.test(actual.chars) &&
        !actual.chars.includes('2h') &&
        !actual.chars.includes('old pace'),
    )
  }
}
console.log(`${checked} reading-state frames and style spans matched`)
