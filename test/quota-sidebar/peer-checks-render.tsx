import assert from 'node:assert/strict'
import {
  type AccountView,
  SidebarFrame,
  type SidebarFrameProps,
  SidebarSection,
  SidebarTextRow,
} from '@cortexkit/common-auth/quota-sidebar'
import { NOW } from './cases.js'
import { appearance, capture, theme } from './render-support.js'

const account: AccountView = {
  id: 'vault',
  label: 'vault',
  status: { text: 'active', tone: 'success' },
  blocked: false,
  indicatorTone: 'success',
  quota: undefined,
  groups: [],
  emptyQuotaText: {
    expanded: 'no quota reading yet',
    collapsed: 'no quota reading yet',
  },
}

async function draw(columns: number, options: Partial<SidebarFrameProps> = {}) {
  return capture(
    () => (
      <SidebarFrame
        header={{ badge: 'TEST' }}
        accounts={[account]}
        appearance={appearance}
        theme={theme}
        now={NOW}
        showQuota={true}
        collapsed={false}
        onToggle={() => {}}
        {...options}
      />
    ),
    columns,
  )
}
const lines = (chars: string) => chars.split('\n').map((line) => line.trim())
const check = process.argv[2]
switch (check) {
  case 'collapsed sections only with collapsed account rows': {
    for (const collapsed of [false, true]) {
      for (const hasData of [false, true]) {
        const called: string[] = []
        const frame = await draw(40, {
          accounts: hasData ? [account] : [],
          collapsed,
          collapsedSections: () => {
            called.push('collapsed')
            return (
              <>
                <SidebarTextRow text='Mode fast' />
                <SidebarTextRow text='Refusal recovery on' />
              </>
            )
          },
          beforeQuota: () => {
            called.push('before')
            return <SidebarTextRow text='before quota' />
          },
          afterQuota: () => {
            called.push('after')
            return <SidebarTextRow text='after quota' />
          },
          sections: () => {
            called.push('expanded')
            return <SidebarSection title='Routing' />
          },
        })
        assert.equal(called.includes('collapsed'), collapsed && hasData)
        assert.equal(frame.chars.includes('Mode fast'), collapsed && hasData)
        assert.equal(
          frame.chars.includes('Refusal recovery on'),
          collapsed && hasData,
        )
        assert.equal(called.includes('expanded'), !collapsed || !hasData)
        assert.equal(called.includes('before'), !collapsed && hasData)
        assert.equal(called.includes('after'), !collapsed && hasData)
        if (collapsed && hasData) {
          const rows = lines(frame.chars)
          const accountIndex = rows.findIndex((line) =>
            line.startsWith('vault'),
          )
          assert.ok(accountIndex >= 0)
          assert.equal(rows[accountIndex + 1], 'Mode fast')
          assert.equal(rows[accountIndex + 2], 'Refusal recovery on')
        }
      }
    }
    break
  }
  case 'mixed gutters at 26 columns':
  case 'mixed gutters at 20 columns': {
    const columns = check.includes('26') ? 26 : 20
    const part = {
      kind: 'window' as const,
      name: '7d',
      short: '7d',
      checkedAt: NOW,
      resetSinceReading: false,
      figure: '50% left',
      remainingPercent: 50,
      resetIn: '45m',
    }
    const frame = await draw(columns, {
      accounts: [
        {
          ...account,
          groups: [
            { title: 'Gemini 7d', rows: [{ part }] },
            {
              title: 'Other models',
              rows: [{ part: { ...part, name: '' } }],
            },
          ],
        },
      ],
    })
    const rows = lines(frame.chars)
    const other = rows[rows.indexOf('Other models') + 1]
    assert.match(
      other ?? '',
      columns === 26 ? /^█████░░░░░ 50% left +45m$/ : /^██░░ 50% left +45m$/,
      `unnamed window must not reserve a name gutter at ${columns} columns`,
    )
    const rawOther = frame.chars
      .split('\n')
      .find((line) => line.trim() === other)
    assert.ok(rawOther?.startsWith(' █'))
    assert.ok(rows[rows.indexOf('Gemini 7d') + 1]?.startsWith('7d '))
    break
  }
  case 'empty quota text stays on one line at 20 columns': {
    const frame = await draw(20, {
      sections: () => <SidebarSection title='Routing' />,
    })
    const rows = lines(frame.chars)
    const accountIndex = rows.findIndex((line) => line.startsWith('vault'))
    assert.ok(rows[accountIndex + 1]?.startsWith('no quota reading'))
    assert.equal(rows[accountIndex + 2], '')
    assert.equal(rows[accountIndex + 3], 'Routing')
    break
  }
  case 'frame text does not wrap but plugin text still can': {
    const frame = await draw(12, {
      accounts: [
        {
          ...account,
          quota: {
            scope: 'all',
            limits: [],
            checkedAt: NOW - 3_600_000,
          },
          groups: [
            {
              title: 'Long group title',
              rows: [
                {
                  part: {
                    kind: 'window',
                    name: '',
                    short: '',
                    figure: '50% left',
                    checkedAt: NOW,
                    resetSinceReading: false,
                  },
                },
              ],
            },
          ],
        },
      ],
      beforeQuota: () => <SidebarTextRow text='plugin text wraps' />,
      afterQuota: () => (
        <SidebarTextRow text='plugin clipped text' wrapMode='none' />
      ),
    })
    const rows = lines(frame.chars)
    assert.ok(rows.includes('plugin'))
    assert.ok(rows.includes('text wraps'))
    assert.ok(!rows.includes('title'))
    assert.ok(!rows.includes('ago'))
    assert.ok(!rows.includes('text'))
    break
  }
  default:
    throw new Error(`Unknown peer check: ${check}`)
}
console.log(`sidebar peer check passed: ${check}`)
