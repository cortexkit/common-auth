import { describe, expect, test } from 'bun:test'
import { budgetExhaustedResetAt, projectQuota } from '../../src/quota/index.js'
import {
  absent,
  at,
  HOUR,
  now,
  quotaMap,
  reading,
  retired,
  spentBudget,
} from './helpers.js'

function labels(scope: string, ...entries: Parameters<typeof quotaMap>[0]) {
  return projectQuota(quotaMap(entries), scope).limits.map(
    (limit) => `${limit.scope}/${limit.label}`,
  )
}

describe('quota projection', () => {
  test('a family request sees only its own family and all-models keys', () => {
    expect(
      labels(
        'family-x',
        reading('primary', 1, { scope: 'family-y' }),
        reading('secondary', 1, { scope: 'family-x' }),
        reading('tertiary', 1),
      ),
    ).toEqual(['family-x/secondary', 'all/tertiary'])
  })

  test('a family reading shadows the all-models entry per label, one entry per label', () => {
    expect(
      labels(
        'family-x',
        reading('primary', 10),
        reading('primary', 90, { scope: 'family-x' }),
      ),
    ).toEqual(['family-x/primary'])
    expect(
      labels(
        'family-x',
        reading('primary', 90, { scope: 'family-x' }),
        reading('primary', 10),
      ),
    ).toEqual(['family-x/primary'])
    expect(
      labels('all', reading('primary', 90, { scope: 'family-x' })),
    ).toEqual([])
  })

  test('a family limit under its own label is projected beside the general limit of the same length', () => {
    expect(
      labels(
        'opus',
        reading('five_hour', 10, { windowMinutes: 300 }),
        reading('seven_day', 100, { windowMinutes: 10_080 }),
        reading('seven_day_opus', 5, {
          scope: 'opus',
          windowMinutes: 10_080,
        }),
      ),
    ).toEqual(['all/seven_day', 'opus/seven_day_opus', 'all/five_hour'])
  })

  test('a family tombstone or absence record does not hide an all-models entry', () => {
    expect(
      labels(
        'family-x',
        retired('primary', 5, 'family-x'),
        reading('primary', 10),
      ),
    ).toEqual(['all/primary'])
    expect(
      labels(
        'family-x',
        absent('primary', 5, 'family-x'),
        reading('primary', 10),
      ),
    ).toEqual(['all/primary'])
    expect(labels('family-x', absent('primary', 5, 'family-x'))).toEqual([
      'family-x/primary',
    ])
  })

  test('limits are ordered longest stored length first with unknown lengths last', () => {
    const projection = projectQuota(
      quotaMap([
        reading('primary', 1, { windowMinutes: 300 }),
        reading('unknown', 1),
        reading('secondary', 1, { windowMinutes: 10_080 }),
        retired('gone', 1),
      ]),
    )
    expect(projection.limits.map((limit) => limit.label)).toEqual([
      'secondary',
      'primary',
      'gone',
      'unknown',
    ])
  })

  test('each limit carries its stored length and an unknown length stays unknown', () => {
    const [known, unknown] = projectQuota(
      quotaMap([
        reading('secondary', 1, { windowMinutes: 10_080 }),
        reading('primary', 1),
      ]),
    ).limits
    expect(known?.windowMinutes).toBe(10_080)
    // openai-auth would read an unlabelled primary as 300 minutes by slot.
    expect(unknown?.label).toBe('primary')
    expect(unknown?.windowMinutes).toBeUndefined()
  })

  test('mixed checkedAt projects the minimum reading time', () => {
    const projection = projectQuota(
      quotaMap([
        reading('primary', 1, { checkedAt: now }),
        reading('secondary', 1, { checkedAt: now - 20 * 60_000 }),
        absent('tertiary', now - 99 * HOUR),
      ]),
    )
    expect(projection.checkedAt).toBe(now - 20 * 60_000)
    expect(projectQuota(quotaMap([absent('primary', 7)])).checkedAt).toBe(7)
    expect(projectQuota(undefined).checkedAt).toBeUndefined()
  })

  test('a reading projects its remaining percent; evidence carries no figures', () => {
    const [limit, evidence] = projectQuota(
      quotaMap([
        reading('primary', 30, { resetsAt: at(HOUR), windowMinutes: 60 }),
        retired('secondary', 9),
      ]),
    ).limits
    expect(limit).toEqual({
      scope: 'all',
      label: 'primary',
      kind: 'reading',
      checkedAt: now,
      usedPercent: 30,
      remainingPercent: 70,
      resetsAt: at(HOUR),
      windowMinutes: 60,
    })
    expect(evidence).toEqual({
      scope: 'all',
      label: 'secondary',
      kind: 'retired',
      checkedAt: 9,
    })
  })

  test('a cleared budget projects no budget and a budget reading projects its signal', () => {
    expect(
      projectQuota({ limits: [], budget: { kind: 'cleared', checkedAt: 1 } })
        .budget,
    ).toBeUndefined()
    const projected = projectQuota(quotaMap([], spentBudget(at(HOUR))))
    expect(projected.budget).toEqual({
      checkedAt: now,
      reached: true,
      remainingPercent: 0,
      resetsAt: at(HOUR),
    })
    expect(budgetExhaustedResetAt(projected, now)).toEqual({
      resetsAt: at(HOUR),
      resetAtMs: now + HOUR,
    })
  })
})
