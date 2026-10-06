import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

function child(env: Record<string, string> = {}) {
  const fixture = fileURLToPath(
    new URL('./hook-overrun.fixture.ts', import.meta.url),
  )
  return new Promise<{ code: number | null; output: string }>(
    (resolve, reject) => {
      const proc = spawn(process.execPath, ['test', fixture], {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      for (const stream of [proc.stdout, proc.stderr])
        stream.on('data', (data: Buffer) => {
          output += data.toString()
        })
      proc.once('error', reject)
      proc.once('close', (code) => resolve({ code, output }))
    },
  )
}

test('old runner wiring exposes a body rejection after its hook is abandoned', async () => {
  const result = await child({ HOOK_OVERRUN_CONTROL: '1' })
  expect(result.code).toBe(1)
  expect(result.output).toContain('(fail) intentional body outlives its hook')
  expect(result.output).toContain('hook timed out')
  expect(result.output).toContain('Unhandled error between tests')
  expect(result.output).toContain('owned late assertion')
})

test('abandoned body failure is visible by owner name and stack, not between tests', async () => {
  const result = await child()
  expect(result.code).toBe(1)
  expect(result.output).toContain('(fail) intentional body outlives its hook')
  expect(result.output).toContain(
    'Late test body failure: intentional body outlives its hook',
  )
  expect(result.output).toContain('error: owned late assertion')
  expect(result.output).toContain('hook-overrun.fixture.ts:')
  expect(result.output).not.toContain('Unhandled error between tests')
})

test('successor wait failure names the previous body without allowing successor setup', async () => {
  const result = await child()
  expect(result.code).toBe(1)
  expect(result.output).toContain(
    'error: Still waiting for previous test body: intentional body outlives its hook',
  )
  expect(result.output).not.toContain('successor setup was allowed')
})

test('normal completion records no late body outcome', async () => {
  const result = await child({ HOOK_OVERRUN_NORMAL: '1' })
  expect(result.code).toBe(0)
  expect(result.output).toContain('(pass) normal body has no late outcome')
  expect(result.output).not.toContain('Late test body')
})

test('unowned late rejection remains an unattributed runner error', async () => {
  const result = await child({
    HOOK_OVERRUN_NORMAL: '1',
    HOOK_OVERRUN_UNRELATED: '1',
  })
  expect(result.code).toBe(1)
  expect(result.output).toContain('Unhandled error between tests')
  expect(result.output).toContain('error: unrelated late rejection')
  expect(result.output).not.toContain('Late test body')
})

test('ordinary body rejection fails its own test without a late outcome', async () => {
  const result = await child({
    HOOK_OVERRUN_NORMAL: '1',
    HOOK_OVERRUN_NORMAL_REJECT: '1',
  })
  expect(result.code).toBe(1)
  expect(result.output).toContain('(fail) normal body has no late outcome')
  expect(result.output).toContain('error: ordinary body assertion')
  expect(result.output).not.toContain('Late test body')
})

test('late body completion is recorded by owner while its timeout remains failed', async () => {
  const result = await child({ HOOK_OVERRUN_FULFILL: '1' })
  expect(result.code).toBe(1)
  expect(result.output).toContain('(fail) intentional body outlives its hook')
  expect(result.output).toContain(
    'Late test body completion: intentional body outlives its hook',
  )
  expect(result.output).not.toContain('Unhandled error between tests')
})
