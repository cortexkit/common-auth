import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { TestLifetime } from './test-lifetime.js'

function child(phase: 'fetch' | 'json', lifetime: boolean, immediate = false) {
  const fixture = fileURLToPath(
    new URL('./rpc-abort.fixture.ts', import.meta.url),
  )
  return new Promise<{ code: number | null; output: string }>(
    (resolve, reject) => {
      const proc = spawn(process.execPath, ['test', fixture], {
        env: {
          ...process.env,
          RPC_ABORT_PHASE: phase,
          RPC_ABORT_LIFETIME: lifetime ? '1' : '0',
          RPC_ABORT_CATCH: '0',
          RPC_ABORT_IMMEDIATE: immediate ? '1' : '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      proc.stdout.on('data', (data) => {
        output += String(data)
      })
      proc.stderr.on('data', (data) => {
        output += String(data)
      })
      proc.on('error', reject)
      proc.on('close', (code) => resolve({ code, output }))
    },
  )
}

for (const phase of ['fetch', 'json'] as const) {
  test(`runner timeout cancels ${phase} in its own drain without a between-tests rejection`, async () => {
    const old = await child(phase, false)
    expect(old.code).toBe(1)
    expect(old.output).toContain(
      '(fail) a request outlives the runner deadline',
    )
    expect(old.output).toContain('this test timed out after 50ms')
    expect(old.output).toContain(`CONTROL ${phase} pending`)
    expect(old.output).toContain(`CONTROL ${phase} rejection TimeoutError`)
    expect(old.output).toContain('Unhandled error between tests')
    expect(old.output).toContain(
      'CONTROL tracked body rejection observed TimeoutError',
    )
    const owned = await child(phase, true)
    expect(owned.code).toBe(1)
    expect(owned.output).toContain(
      '(fail) a request outlives the runner deadline',
    )
    expect(owned.output).toContain('this test timed out after 50ms')
    expect(owned.output).toContain(`CONTROL ${phase} pending`)
    expect(owned.output).toContain(`CONTROL ${phase} rejection AbortError`)
    expect(owned.output).toContain('CONTROL tracked body fulfilled')
    expect(owned.output).not.toContain('Unhandled error between tests')
    expect(owned.output).not.toContain('CONTROL unhandled identity')
  })
}

test('lifetime aborts requests before joining bodies and before cleanup', async () => {
  const lifetime = new TestLifetime()
  const steps: string[] = []
  const body = lifetime.tracked(async () => {
    await new Promise<void>((_resolve, reject) => {
      lifetime.signal.addEventListener(
        'abort',
        () => {
          steps.push('abort')
          reject(lifetime.signal.reason)
        },
        { once: true },
      )
    })
  })
  await Promise.resolve()
  await lifetime.drain(() => {
    steps.push('cleanup')
  })
  expect(lifetime.signal.aborted).toBe(true)
  expect(await body).toBeUndefined()
  expect(steps).toEqual(['abort', 'cleanup'])
})

test('lifetime preserves an unrelated body rejection during teardown', async () => {
  const lifetime = new TestLifetime()
  const error = new Error('assertion must remain visible')
  const body = lifetime.tracked(async () => {
    await new Promise<void>((resolve) => lifetime.unpark(resolve))
    throw error
  })
  await Promise.resolve()
  await lifetime.drain(() => {})
  await expect(body).rejects.toBe(error)
})

test('lifetime preserves a timer abort rather than treating it as teardown cancellation', async () => {
  const lifetime = new TestLifetime()
  const timerReason = new DOMException('timer expired', 'TimeoutError')
  const body = lifetime.tracked(async () => {
    await new Promise<void>((resolve) => lifetime.unpark(resolve))
    throw timerReason
  })
  await Promise.resolve()
  await lifetime.drain(() => {})
  await expect(body).rejects.toBe(timerReason)
})

test('JSON cancellation phase control rejects an immediately completed response body', async () => {
  for (const owned of [false, true]) {
    const result = await child('json', owned, true)
    expect(result.code).toBe(1)
    expect(result.output).toContain(
      'JSON phase control requires a pending body',
    )
    expect(result.output).toContain('Received: "fulfilled"')
    expect(result.output).not.toContain('CONTROL json pending')
    expect(result.output).not.toContain('this test timed out')
  }
})
