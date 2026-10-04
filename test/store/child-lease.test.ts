import { afterEach, beforeEach, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { POOL_LOCK_DEFAULTS } from '../../src/store/refresh-lock.js'
import {
  CRASH_EXIT_CODE,
  childLeases,
  oauth,
  runChild,
  type Scenario,
  scenario,
} from './helpers.js'

let s: Scenario
beforeEach(async () => {
  s = await scenario()
})
afterEach(() => s.cleanup())

it('a deliberately short renewing child lease lapses during an event-loop stall and fails rather than missing the crash step', async () => {
  const child = runChild({
    ...s.paths,
    op: 'add',
    id: 'a',
    credential: oauth('r-a'),
    exitAt: 'after-state-write',
    ttlMs: 1_000,
    renew: true,
    stallAfterAcquireMs: 1_200,
  })
  expect(await child.exited).toBe(1)
  const output = child.output()
  expect(output).toContain('failed:lock-ownership\n')
  expect(output).not.toContain('step:')
  const lease = childLeases(output)[0]
  const stalled = JSON.parse(
    output
      .split('\n')
      .find((line) => line.startsWith('stalled:'))
      ?.slice(8) ?? '{}',
  )
  expect(stalled.ownerId).toBe(lease?.ownerId)
  expect(stalled.expiresAt).toBe(lease?.expiresAt)
  expect(stalled.now).toBeGreaterThan(stalled.expiresAt)
  expect(await s.bytes()).toEqual({ config: null, state: null })
})

it('a crash child uses production leases and renewal, and only the exited child has its records expired in place', async () => {
  const child = runChild({
    ...s.paths,
    op: 'add',
    id: 'a',
    credential: oauth('r-a'),
    exitAt: 'after-state-write',
    stallAfterAcquireMs: 1_200,
    pauseBeforeStateMs: POOL_LOCK_DEFAULTS.ttlMs / 3 + 500,
  })
  await child.printed('lease:')
  const first = childLeases(child.output())[0]
  if (!first) throw new Error('child did not announce its lease')
  const inode = (await stat(first.path)).ino
  const live = JSON.parse(await readFile(first.path, 'utf8'))
  expect(live.expiresAt).toBeGreaterThan(Date.now())
  expect(await child.exited).toBe(CRASH_EXIT_CODE)
  expect(child.output()).toContain('step:after-state-write\n')
  expect(child.output()).not.toContain('failed:')
  const renewed = child
    .output()
    .split('\n')
    .filter((line) => line.startsWith('renewed:'))
    .map((line) => JSON.parse(line.slice(8)))
  for (const lease of childLeases(child.output())) {
    expect(lease.expiresAt - lease.acquiredAt).toBeGreaterThan(
      POOL_LOCK_DEFAULTS.ttlMs - 500,
    )
    expect(lease.expiresAt - lease.acquiredAt).toBeLessThanOrEqual(
      POOL_LOCK_DEFAULTS.ttlMs,
    )
    expect(
      renewed.find((record) => record.ownerId === lease.ownerId)?.expiresAt,
    ).toBeGreaterThan(lease.expiresAt)
    const text = await readFile(lease.path, 'utf8')
    const expired = JSON.parse(text)
    expect(Buffer.byteLength(text)).toBe(128)
    expect(expired).toEqual({
      ownerId: lease.ownerId,
      expiresAt: 0,
      check: createHash('sha256')
        .update(JSON.stringify([lease.ownerId, 0]))
        .digest('hex')
        .slice(0, 16),
    })
  }
  expect((await stat(first.path)).ino).toBe(inode)
  // Normal acquisition, not fixture deletion, reaps the abandoned records.
  expect(
    (await s.open().add({ id: 'b', credential: oauth('r-b') })).outcome,
  ).toBe('added')
}, 15_000)
