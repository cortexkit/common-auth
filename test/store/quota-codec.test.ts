import { beforeEach, expect } from 'bun:test'
import {
  projectQuota,
  type QuotaMap,
  quotaCodec,
} from '../../src/quota/index.js'
import { admit } from '../../src/routing/index.js'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { oauth, type Scenario, scenario } from './helpers.js'

const hooks = lifetimeHooks()
const { afterEach, test } = hooks

let s: Scenario
beforeEach(async () => {
  s = hooks.lifetime.manage(await scenario())
})
afterEach(() => s.cleanup())

// The store's own tests use a trivial codec; this one opens it with the real
// quota model so the two subpaths are proven to fit: a pulled observation is
// merged, persisted, reloaded, and read by admission.
test('the store persists observations through the quota codec and admission reads them back', async () => {
  const store = s.open({
    quota: quotaCodec,
    pull: async () => ({
      checkedAt: 1_000,
      readings: [{ label: 'primary', usedPercent: 40, windowMinutes: 300 }],
      coverage: [{ label: 'secondary' }],
    }),
  })
  await store.add({ id: 'a', credential: oauth('r-a') })
  await store.pullsSettled()

  const reopened = s.open({ quota: quotaCodec })
  const load = await reopened.read()
  if (load.status !== 'ready') throw new Error('expected ready')
  const row = load.rows.find((candidate) => candidate.id === 'a')
  expect(row?.needsFirstReading).toBe(false)
  const map = row?.quota as QuotaMap
  expect(quotaCodec.validate(map)).toBe(true)
  const projection = projectQuota(map)
  expect(projection.limits.map((limit) => [limit.label, limit.kind])).toEqual([
    ['primary', 'reading'],
    ['secondary', 'absent'],
  ])

  const verdict = admit({
    rows: [{ id: 'a', kind: 'oauth', quota: map }],
    now: 2_000,
  })
  expect(verdict.admitted.map((candidate) => candidate.id)).toEqual(['a'])
})
