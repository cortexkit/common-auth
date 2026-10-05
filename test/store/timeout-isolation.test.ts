import { expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeRepoScratchDir } from '../fixtures/scratch.js'

it('a real runner timeout drains parked store work and final body reads before the successor test without unhandled errors', async () => {
  const dir = await makeRepoScratchDir('timeout-isolation-')
  try {
    const source = (
      await readFile(
        new URL('./timeout-isolation.fixture.ts', import.meta.url),
        'utf8',
      )
    )
      .replace(
        "'./helpers.js'",
        JSON.stringify(new URL('./helpers.ts', import.meta.url).pathname),
      )
      .replace(
        "'./test-lifetime.js'",
        JSON.stringify(new URL('./test-lifetime.ts', import.meta.url).pathname),
      )
    const path = join(dir, 'isolation.test.ts')
    await writeFile(path, source)
    const child = spawn(process.execPath, ['test', path], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk: Buffer) => {
        output += chunk.toString()
      })
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    expect(code).toBe(1)
    expect(output).toContain('(fail) intentional parked refresh timeout')
    expect(output).toContain('timed out after 20ms')
    expect(output).toContain(
      '(pass) successor sees only its own scenario after the timed-out body is terminal',
    )
    expect(output).toContain('timed-out body final read: after')
    expect(output).toContain('1 pass')
    expect(output).toContain('1 fail')
    expect(output).not.toContain('Unhandled error')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
