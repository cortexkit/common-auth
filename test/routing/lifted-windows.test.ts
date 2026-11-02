import { describe, expect, test } from 'bun:test'
import { type AdmissionInput, admit } from '../../src/routing/index.js'
import { at, now, quotaMap, reading } from '../quota/helpers.js'
import { oauth } from './helpers.js'

const lifted = [{ scope: 'all', label: 'primary' }]
const exhausted = (label = 'primary', scope = 'all', resetsAt = at(-1000)) =>
  reading(label, 100, { scope, resetsAt })

function run(patch: Partial<AdmissionInput> = {}) {
  const fired: string[] = []
  const result = admit({
    rows: [oauth('A', quotaMap([exhausted()]))],
    now,
    requestPull: (id) => {
      fired.push(id)
    },
    liftedWindows: new Map([['A', lifted]]),
    ...patch,
  })
  return { ...result, fired }
}

describe('one-dispatch lifted admission windows', () => {
  test('gate 4 admits a lifted passed-reset window but still requests its pull', () => {
    const result = run()
    expect(result.admitted.map((row) => row.id)).toEqual(['A'])
    expect(result.refused).toEqual([])
    expect(result.pulls).toEqual(['A'])
    expect(result.fired).toEqual(['A'])
    expect(result.admitted[0]?.projection?.limits[0]?.usedPercent).toBe(100)
    expect(run({ liftedWindows: undefined }).refused).toMatchObject([
      { gate: 4, reason: 'unknown-reset' },
    ])
  })

  test('lifting is scoped to the exact row, scope and label', () => {
    for (const liftedWindows of [
      new Map([['B', lifted]]),
      new Map([['A', [{ scope: 'claude', label: 'primary' }]]]),
      new Map([['A', [{ scope: 'all', label: 'weekly' }]]]),
    ])
      expect(run({ liftedWindows }).refused).toMatchObject([{ gate: 4 }])
    const result = run({
      rows: [
        oauth('A', quotaMap([exhausted()])),
        oauth('B', quotaMap([exhausted()])),
      ],
    })
    expect(result.admitted.map((row) => row.id)).toEqual(['A'])
    expect(result.refused).toMatchObject([{ id: 'B', gate: 4 }])
  })

  test('an unlifted second window still refuses, with a single pull per row', () => {
    const result = run({
      rows: [oauth('A', quotaMap([exhausted(), exhausted('weekly')]))],
    })
    expect(result.refused).toMatchObject([
      { gate: 4, window: { label: 'weekly' } },
    ])
    expect(result.fired).toEqual(['A'])
    expect(result.pulls).toEqual(['A'])
  })

  test('lifting never waives first-reading, required-label or future-exhaustion gates', () => {
    expect(run({ rows: [oauth('A')] }).refused).toMatchObject([{ gate: 2 }])
    expect(
      run({ rows: [oauth('A', quotaMap([exhausted('weekly')]))] }).refused,
    ).toMatchObject([{ gate: 3 }])
    expect(
      run({
        rows: [oauth('A', quotaMap([exhausted('primary', 'all', at(1000))]))],
      }).refused,
    ).toMatchObject([{ gate: 5 }])
  })

  test('control exclusions still precede lifting and request no pull', () => {
    for (const exclusions of [
      { rateLimitMarks: new Map([['A', now + 1000]]) },
      { refreshBackoff: new Map([['A', now + 1000]]) },
    ]) {
      const result = run(exclusions)
      expect(result.excluded).toHaveLength(1)
      expect(result.admitted).toEqual([])
      expect(result.pulls).toEqual([])
    }
  })

  test('pulls from lifted and refused rows retain input order without duplicates', () => {
    const result = run({
      rows: [oauth('B'), oauth('A', quotaMap([exhausted()]))],
    })
    expect(result.pulls).toEqual(['B', 'A'])
    expect(result.fired).toEqual(['B', 'A'])
  })
})
