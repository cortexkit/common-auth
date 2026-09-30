import { describe, expect, test } from 'bun:test'
import {
  emptyQuotaMap,
  isQuotaMap,
  mergeQuotaObservation,
  quotaCodec,
} from '../../src/quota/index.js'
import {
  absent,
  at,
  quotaMap,
  reading,
  reload,
  retired,
  spentBudget,
} from './helpers.js'

describe('quota map', () => {
  test('a quota map with every entry kind and a budget validates after a reload', () => {
    const map = quotaMap(
      [
        reading('primary', 20, { resetsAt: at(1000), windowMinutes: 300 }),
        retired('secondary', 5),
        absent('primary', 6, 'family-x'),
      ],
      spentBudget(at(1000)),
    )
    expect(isQuotaMap(reload(map))).toBe(true)
    expect(isQuotaMap(emptyQuotaMap())).toBe(true)
    expect(
      isQuotaMap({ limits: [], budget: { kind: 'cleared', checkedAt: 1 } }),
    ).toBe(true)
  })

  test('validation rejects a duplicated key, a malformed entry and a malformed budget', () => {
    expect(isQuotaMap(undefined)).toBe(false)
    expect(isQuotaMap({})).toBe(false)
    expect(
      isQuotaMap(quotaMap([reading('primary', 1), retired('primary', 2)])),
    ).toBe(false)
    expect(
      isQuotaMap({ limits: [{ ...reading('primary', 1), kind: 'x' }] }),
    ).toBe(false)
    expect(
      isQuotaMap({ limits: [{ ...reading('primary', 1), scope: '' }] }),
    ).toBe(false)
    expect(
      isQuotaMap({ limits: [{ ...reading('primary', 1), usedPercent: null }] }),
    ).toBe(false)
    expect(
      isQuotaMap({ limits: [], budget: { kind: 'reading', checkedAt: 1 } }),
    ).toBe(false)
  })

  test('the quota codec exposes validation and merge for the store', () => {
    expect(quotaCodec.validate).toBe(isQuotaMap)
    expect(quotaCodec.merge).toBe(mergeQuotaObservation)
    expect(Object.isFrozen(quotaCodec)).toBe(true)
    expect(
      quotaCodec.validate(
        quotaCodec.merge(undefined, {
          checkedAt: 1,
          coverage: [{ label: 'p' }],
        }),
      ),
    ).toBe(true)
  })
})
