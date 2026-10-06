import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { makeRepoScratchDir } from './scratch.js'

test('renewal staging lock is released by its lifetime when setup fails before the body finally', async () => {
  const dir = await makeRepoScratchDir('renewal-ownership-')
  try {
    const original = new URL('../fs/with-lock.test.ts', import.meta.url)
      .pathname
    let source = await readFile(original, 'utf8')
    const title =
      'renewal stages private owner bytes and atomically renames while assertOwned remains valid'
    const start = source.indexOf(`test('${title}'`)
    const point = source.indexOf('  const before =', start)
    if (start < 0 || point < start)
      throw new Error('missing renewal staging body')
    // Fail before the body installs its spies and enters try/finally. Only the
    // lifetime's resource finalizer can release the acquired handle on this path.
    source =
      source.slice(0, point) +
      `
  const release = lock!.release.bind(lock)
  lock!.release = async () => { await release(); __released = true }
  throw new Error('intentional failure before renewal setup completes')
` +
      source.slice(point)
    source = source.replace(
      /(from\s*|import\s*\()(['"])(\.[^'"]+)\2/g,
      (_match, prefix: string, _quote: string, path: string) =>
        `${prefix}${JSON.stringify(resolve(dirname(original), path))}`,
    )
    source += `
let __released = false
test('successor sees renewal handle released', () => { expect(__released).toBe(true) })
`
    const path = join(dir, 'ownership.test.ts')
    await writeFile(path, source)
    const child = spawn(
      process.execPath,
      ['test', path, '-t', `${title}|successor sees renewal handle released`],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let output = ''
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (data: Buffer) => {
        output += data.toString()
      })
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    expect(code).toBe(1)
    expect(output).toContain(
      'intentional failure before renewal setup completes',
    )
    expect(output).toContain('(pass) successor sees renewal handle released')
    expect(output).toContain('1 fail')
    expect(output).not.toContain('Unhandled error')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
