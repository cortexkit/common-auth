import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

// Reorder actual filesystem awaits in a copied test, without editing production
// code or its expectation. The first scheduled sweep stays parked until the aged
// artifact is present; the second dump cannot start another interval sweep.
const title = 'the automatic sweep runs at most once per interval while sweep runs now'
const original = resolve('test/dump/dump.test.ts')
let source = await readFile(original, 'utf8')
const start = source.indexOf(`  test('${title}'`)
const end = source.indexOf('\n  })', start) + '\n  })'.length
assert(start >= 0 && end > start, 'original interval test exists')
let body = source.slice(start, end)
const declaration = "    const d = dumper({ maxBytes: 1, now: () => t, sweepMinAgeMs: 0 })"
assert(body.includes(declaration), 'original interval dumper exists')
body = body.replace(declaration, `${declaration}
    const gate = () => {
      let resolve
      const promise = new Promise(next => { resolve = next })
      return { promise, resolve }
    }
    const entered = gate(), release = gate(), removed = gate()
    let parked = false
    const originalLstat = __fs.lstat, originalUnlink = __fs.unlink
    const statSpy = __spyOn(__fs, 'lstat').mockImplementation(async (...args) => {
      if (String(args[0]) === dumpDir && !parked) {
        parked = true
        entered.resolve()
        await release.promise
      }
      return originalLstat(...args)
    })
    const unlinkSpy = __spyOn(__fs, 'unlink').mockImplementation(async (...args) => {
      const result = await originalUnlink(...args)
      if (String(args[0]) === join(dumpDir, dumpArtifactName(1))) removed.resolve()
      return result
    })
    hooks.lifetime.finish(async () => { statSpy.mockRestore(); unlinkSpy.mockRestore() })
`)
const dump = "    await d.dump({ session: 's', channel: 'http', bodyText: '{}' })"
assert.equal(body.split(dump).length, 3, 'two original dump calls exist')
body = body.replace(dump, `${dump}\n    await entered.promise`)
const second = body.lastIndexOf(dump) + dump.length
body = body.slice(0, second) + '\n    release.resolve()\n    await removed.promise' + body.slice(second)
source = source.slice(0, start) + body + source.slice(end)
source = `import * as __fs from 'node:fs/promises'\nimport { spyOn as __spyOn } from 'bun:test'\n` + source
source = source.replace(/(from\s*|import\s*\()(['"])(\.[^'"]+)\2/g,
  (_match, prefix, _quote, path) => `${prefix}${JSON.stringify(resolve(dirname(original), path))}`)
const dir = await mkdtemp(resolve('test/.scratch-dump-overlap-'))
try {
  const path = join(dir, 'overlap.test.ts')
  await writeFile(path, source)
  const child = spawnSync(process.execPath, ['test', path, '-t', title], { encoding: 'utf8' })
  const output = child.stdout + child.stderr
  console.log(output)
  assert.equal(child.status, 1, 'the unchanged interval assertion must fail')
  assert(output.includes(`(fail) dump directory byte cap > ${title}`), 'the interval test failed')
  assert(output.includes('error: expect(received).toContain(expected)'), 'the original membership assertion failed')
  assert(!output.includes('this test timed out'), 'the probe reached the assertion rather than hanging')
  console.log('First-sweep overlap reproduces the original assertion failure; production source unchanged.')
} finally {
  await rm(dir, { recursive: true, force: true })
}
