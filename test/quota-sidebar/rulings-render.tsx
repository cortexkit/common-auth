import assert from 'node:assert/strict'
import { projectQuota, quotaWindowParts } from '@cortexkit/common-auth/quota'
import {
  type AccountView,
  SidebarFrame,
  type SidebarTheme,
} from '@cortexkit/common-auth/quota-sidebar'
import { NOW } from './cases.js'
import { appearance, capture, theme } from './render-support.js'

const quota = projectQuota({
  limits: [
    {
      kind: 'reading',
      scope: 'all',
      label: 'short',
      usedPercent: 50,
      checkedAt: NOW,
      windowMinutes: 300,
      resetsAt: new Date(NOW + 86_340_000).toISOString(),
    },
    {
      kind: 'reading',
      scope: 'all',
      label: 'long',
      usedPercent: 25,
      checkedAt: NOW,
      windowMinutes: 10080,
      resetsAt: new Date(NOW + 345_540_000).toISOString(),
    },
  ],
})
const [firstPart, secondPart] = quotaWindowParts(quota, { now: NOW }).windows
if (!firstPart || !secondPart) throw new Error('Expected two quota windows')
const account: AccountView = {
  id: 'one',
  label: 'long-account-name',
  status: { text: 'blocked', tone: 'error' },
  blocked: true,
  indicatorTone: 'error',
  quota,
  groups: [
    {
      rows: quotaWindowParts(quota, { now: NOW }).windows.map((part) => ({
        part,
      })),
    },
  ],
}
async function draw(
  contentWidth: number,
  options: {
    collapsed?: boolean
    account?: AccountView
    theme?: SidebarTheme
    barWidth?: number
  } = {},
) {
  return capture(
    () => (
      <SidebarFrame
        header={{ badge: 'TEST', version: 'v1' }}
        accounts={[options.account ?? account]}
        theme={'theme' in options ? options.theme : theme}
        appearance={{ ...appearance, barWidth: options.barWidth ?? 10 }}
        now={NOW}
        showQuota={true}
        collapsed={options.collapsed ?? false}
        onToggle={() => {}}
      />
    ),
    contentWidth,
  )
}
const lines = (chars: string) => chars.split('\n').map((line) => line.trim())
const rule = process.argv[2]
switch (rule) {
  case '2': {
    const narrow = await draw(24)
    assert.ok(
      lines(narrow.chars).includes('5h ██░░ 50% left  23h59m'),
      `ruling 2: shrink bar to four before dropping reset\n${narrow.chars}`,
    )
    assert.ok(
      lines(narrow.chars).includes('7d █░░░ 75% left   3d23h'),
      'ruling 2: reset column is shared across the account',
    )
    const smaller = await draw(23)
    assert.ok(
      !smaller.chars.includes('23h59m'),
      'ruling 2: drop reset only below the four-cell boundary',
    )
    assert.ok(lines(smaller.chars).includes('5h █████░░░░░ 50% left'))
    const wideBar = await draw(30, { barWidth: 40 })
    assert.ok(lines(wideBar.chars).includes('5h █████░░░░░ 50% left  23h59m'))
    const mixed = {
      ...account,
      groups: [
        {
          rows: [
            { part: { ...firstPart, resetIn: '2h' } },
            {
              part: {
                ...secondPart,
                figure: '100% left',
                remainingPercent: 100,
              },
            },
          ],
        },
      ],
    }
    const aligned = await draw(23, { account: mixed })
    assert.ok(lines(aligned.chars).includes('5h ██░░ 50% left     2h'))
    assert.ok(lines(aligned.chars).includes('7d ░░░░ 100% left 3d23h'))
    break
  }
  case '3': {
    const part = firstPart
    const resetQuota = projectQuota({
      limits: [
        {
          kind: 'reading',
          scope: 'all',
          label: 'short',
          usedPercent: 50,
          checkedAt: NOW - 3_600_000,
          windowMinutes: 300,
          resetsAt: new Date(NOW - 60_000).toISOString(),
        },
      ],
    })
    const reset = await draw(35, {
      theme,
      account: {
        ...account,
        quota: resetQuota,
        groups: [
          {
            rows: [
              {
                part: { ...part, resetIn: undefined, resetSinceReading: true },
                pace: { text: 'old pace', tone: 'warning' },
              },
            ],
          },
        ],
      },
    })
    assert.ok(
      lines(reset.chars).includes('5h reset since last check'),
      'ruling 3: replace historical percent and bar after reset',
    )
    assert.ok(
      !reset.chars.includes('% left') &&
        !reset.chars.includes('█') &&
        !reset.chars.includes('old pace'),
    )
    assert.ok(
      reset.chars.indexOf('checked 1h ago') >
        reset.chars.indexOf('reset since last check'),
    )
    const span = reset.spans.lines
      .flatMap((line) => line.spans)
      .find((span) => span.text.includes('reset since last check'))
    assert.deepEqual(span?.fg, theme.textMuted)
    break
  }
  case '6': {
    for (const blocked of [false, true]) {
      const empty = await draw(35, {
        collapsed: true,
        account: {
          ...account,
          blocked,
          quota: undefined,
          groups: [],
          emptyQuotaText: {
            expanded: 'checking…',
            collapsed: 'no quota reading yet',
          },
        },
      })
      assert.ok(
        lines(empty.chars).some((line) =>
          line.endsWith(`no quota reading yet ${blocked ? '⊘' : '●'}`),
        ),
        'ruling 6: unread accounts retain a trailing indicator',
      )
    }
    break
  }
  case '7': {
    const full = await draw(24, { collapsed: true })
    assert.ok(
      lines(full.chars).includes('… 5h 50% · 7d 75% left ⊘'),
      'ruling 7: cut the label first and keep the complete narrow text',
    )
    const narrow = await draw(23, { collapsed: true })
    assert.ok(
      lines(narrow.chars).includes('long-account-name     ⊘'),
      'ruling 7: replace an unfittable quota with label and dot only',
    )
    assert.ok(!narrow.chars.includes('%') && !narrow.chars.includes('left'))
    const tiny = await draw(6, { collapsed: true })
    assert.ok(lines(tiny.chars).includes('lon… ⊘'))
    const dotOnly = await draw(1, { collapsed: true })
    assert.ok(
      lines(dotOnly.chars).includes('⊘'),
      'ruling 7: keep the dot even when no label cell fits',
    )
    break
  }
  case '8': {
    const unnamed = {
      ...account,
      groups: [{ rows: [{ part: { ...firstPart, name: '' } }] }],
    }
    const frame = await draw(35, { account: unnamed })
    assert.ok(
      frame.chars
        .split('\n')
        .some((line) => line.startsWith('█████░░░░░ 50% left')),
      `ruling 8: unnamed blocks have no name gutter\n${frame.chars}`,
    )
    const wideName = await draw(35, {
      account: {
        ...account,
        groups: [{ rows: [{ part: { ...firstPart, name: '日' } }] }],
      },
    })
    assert.ok(
      wideName.chars
        .split('\n')
        .some((line) => line.startsWith('日 █████░░░░░ 50% left')),
      'ruling 8: size the gutter in terminal cells',
    )
    break
  }
  case '9': {
    const fallback = await draw(35, {
      theme: { text: '#123456', background: undefined },
    })
    const colored = fallback.spans.lines
      .flatMap((line) => line.spans)
      .find((span) => span.text.includes('50% left'))
    assert.deepEqual(
      Array.from(colored?.fg.buffer ?? []),
      [18, 52, 86, 255],
      'ruling 9: missing semantic colors fall back to normal text',
    )
    const badge = fallback.spans.lines
      .flatMap((line) => line.spans)
      .find((span) => span.text.includes('TEST'))
    assert.deepEqual(
      Array.from(badge?.fg.buffer ?? []),
      [18, 52, 86, 255],
      'ruling 9: a sparse badge palette remains readable',
    )
    assert.deepEqual(Array.from(badge?.bg.buffer ?? []), [0, 0, 0, 0])
    const unset = await draw(35, { theme: undefined })
    assert.ok(
      unset.chars.includes('50% left'),
      'ruling 9: unset theme uses terminal defaults',
    )
    assert.equal(unset.chars, fallback.chars)
    break
  }
  case '10': {
    const frame = await draw(35, {
      account: { ...account, label: 'stale-idle-long-account-name' },
    })
    assert.ok(
      lines(frame.chars).includes('stale-idle-long-account-na… blocked'),
      'ruling 10: ellipsize the name and reserve a space before status',
    )
    assert.equal(
      lines(frame.chars).filter((line) => line.includes('blocked')).length,
      1,
    )
    break
  }
  default:
    throw new Error(`Unknown ruling: ${rule}`)
}
console.log(`sidebar ruling ${rule} passed`)
