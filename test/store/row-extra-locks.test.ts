import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { LockEvent } from '../../src/store/index.js'
import { oauth, type Scenario, scenario } from './helpers.js'

let s: Scenario
beforeEach(async () => {
  s = await scenario()
})
afterEach(() => s.cleanup())

function recorder() {
  const log: string[] = []
  const onLockEvent = (event: LockEvent) => {
    if (event.type !== 'acquired') return
    log.push(
      `${event.name}@${event.path === s.configPath ? 'config' : 'state'}`,
    )
  }
  return { log, onLockEvent }
}

// Row writes take a caller's extra locks where refresh takes them: after the
// row and provider-wide locks, before the store locks. A caller holding
// legacy locks around both then acquires every lock in one order.
test('add, replace, rotate and recordIdentity take extra locks after the row and provider-wide locks and before the store locks', async () => {
  const extras = [
    { name: 'extra-1', path: s.statePath },
    { name: 'extra-2', path: s.statePath },
  ]
  const cases: Array<
    [string, (r: ReturnType<typeof recorder>) => Promise<unknown>]
  > = [
    [
      'add',
      (r) =>
        s
          .open({ onLockEvent: r.onLockEvent })
          .add(
            { id: 'a', credential: oauth('r-a'), identity: 'acct-1' },
            { extraLocks: extras },
          ),
    ],
    [
      'replace',
      (r) =>
        s
          .open({ onLockEvent: r.onLockEvent })
          .replace(
            'a',
            oauth('r-b'),
            { identity: 'acct-1' },
            { extraLocks: extras },
          ),
    ],
    [
      'rotate',
      (r) =>
        s
          .open({ onLockEvent: r.onLockEvent })
          .rotate(
            'a',
            oauth('r-c'),
            { identity: 'acct-1' },
            { extraLocks: extras },
          ),
    ],
    [
      'recordIdentity',
      (r) =>
        s
          .open({ onLockEvent: r.onLockEvent })
          .recordIdentity('a', 'acct-1', { extraLocks: extras }),
    ],
  ]
  for (const [name, run] of cases) {
    const r = recorder()
    await run(r)
    expect({ name, log: r.log }).toEqual({
      name,
      log: [
        'row-acct-1@state',
        'provider-openai@state',
        'extra-1@state',
        'extra-2@state',
        'save@config',
        'save@state',
      ],
    })
  }
})

// disable, enable and remove change no identity keying, so they take no
// provider-wide lock; otherwise they lock as every other row write does, so a
// removal waits for a refresh of the row instead of landing during its
// provider call.
test('disable, enable and remove take the row lock, then extra locks, then the store locks', async () => {
  const extras = [
    { name: 'extra-1', path: s.statePath },
    { name: 'extra-2', path: s.statePath },
  ]
  await s.open().add({ id: 'a', credential: oauth('r-a'), identity: 'acct-1' })
  const cases: Array<
    [string, (r: ReturnType<typeof recorder>) => Promise<unknown>]
  > = [
    [
      'disable',
      (r) =>
        s
          .open({ onLockEvent: r.onLockEvent })
          .disable('a', 'manual', { extraLocks: extras }),
    ],
    [
      'enable',
      (r) =>
        s
          .open({ onLockEvent: r.onLockEvent })
          .enable('a', { extraLocks: extras }),
    ],
    [
      'remove',
      (r) =>
        s
          .open({ onLockEvent: r.onLockEvent })
          .remove('a', { extraLocks: extras }),
    ],
  ]
  for (const [name, run] of cases) {
    const r = recorder()
    await run(r)
    expect({ name, log: r.log }).toEqual({
      name,
      log: [
        'row-acct-1@state',
        'extra-1@state',
        'extra-2@state',
        'save@config',
        'save@state',
      ],
    })
  }
})
