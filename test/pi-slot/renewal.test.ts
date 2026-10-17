import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

async function probe(scenario: string): Promise<unknown> {
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL('./renewal-child.ts', import.meta.url)),
      scenario,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
  return JSON.parse(stdout)
}

test.skipIf(process.platform === 'win32')(
  'pi slot renewal completes while one durable fsync is pending',
  async () => {
    expect(await probe('single')).toEqual({
      pending: 1,
      completed: 1,
      queuedStat: 0,
      queuedUtimes: 0,
      advanced: [true],
    })
  },
)

test.skipIf(process.platform === 'win32')(
  'pi slot renewal completes while durable fsyncs saturate the async pool',
  async () => {
    expect(await probe('saturated')).toEqual({
      pending: 4,
      completed: 4,
      queuedStat: 0,
      queuedUtimes: 0,
      advanced: [true, true, true, true],
    })
  },
)

for (const operation of ['stat', 'utimes']) {
  test(`pi slot renewal refuses expiry during synchronous ${operation}`, async () => {
    expect(await probe(`slow-${operation}`)).toEqual({
      compromised: 1,
      lockRemains: true,
      syncUpdates: operation === 'stat' ? 0 : 1,
    })
  })
}
