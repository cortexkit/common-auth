import { describe, expect, test } from 'bun:test'
import { SetupProcessGuard } from '../../src/setup/process-guard.js'

describe('setup process guard', () => {
  test('only explicit reuse skips a successful uninterrupted inspection', async () => {
    let checks = 0
    const guard = new SetupProcessGuard(
      async () => {
        checks++
      },
      () => 0,
    )
    await guard.check({ reuse: true })
    await guard.check({ reuse: true })
    await guard.check({ reuse: true })
    expect(checks).toBe(1)
    await guard.check()
    expect(checks).toBe(2)
  })

  for (const kind of [
    'callback',
    'reconcile',
    'config write',
    'prompt',
    'wait',
  ]) {
    test(`${kind} step clears freshness before and after running`, async () => {
      const events: string[] = []
      const guard = new SetupProcessGuard(
        async () => {
          events.push('check')
        },
        () => 0,
      )
      await guard.check()
      await guard.step(async () => {
        events.push(kind)
        await guard.check({ reuse: true })
      })
      await guard.check({ reuse: true })
      expect(events).toEqual(['check', kind, 'check', 'check'])
    })
  }

  test('a throwing step cannot preserve even a nested successful inspection', async () => {
    let checks = 0
    const guard = new SetupProcessGuard(
      async () => {
        checks++
      },
      () => 0,
    )
    const failure = new Error('callback failed')
    await guard.check()
    await expect(
      guard.step(async () => {
        await guard.check({ reuse: true })
        throw failure
      }),
    ).rejects.toBe(failure)
    await guard.check({ reuse: true })
    expect(checks).toBe(3)
  })

  test('a failed inspection is never reusable', async () => {
    let checks = 0
    const guard = new SetupProcessGuard(
      async () => {
        if (++checks === 2) throw new Error('inspection failed')
      },
      () => 0,
    )
    await guard.check()
    await expect(guard.check()).rejects.toThrow('inspection failed')
    await guard.check({ reuse: true })
    expect(checks).toBe(3)
  })

  test('freshness expires five seconds after inspection finishes', async () => {
    let now = 0
    let checks = 0
    const guard = new SetupProcessGuard(
      async () => {
        checks++
        now += 30_000
      },
      () => now,
    )
    await guard.check()
    now += 4999
    await guard.check({ reuse: true })
    expect(checks).toBe(1)
    now++
    await guard.check({ reuse: true })
    expect(checks).toBe(2)
  })
})
