import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

// Copy the automatic-sweep interval test and park its first directory lstat.
// Waiting for the sweep's terminal removal log must prevent adding the aged
// artifact used to check interval throttling until the parked call is released.
const title = 'the automatic sweep runs at most once per interval while sweep runs now'
const original = resolve('test/dump/dump.test.ts')
let source = await readFile(original, 'utf8')
const start = source.indexOf(`  test('${title}'`)
const end = source.indexOf('\n  })', start) + '\n  })'.length
assert(start >= 0 && end > start, 'original interval test exists')
let body = source.slice(start, end)
const spy = "    const statSpy = spyOn(fs, 'lstat')"
assert(body.includes(spy), 'interval test observes directory lstat')
body = body.replace(spy, `
    let enter, release
    const entered = new Promise(resolve => { enter = resolve })
    const released = new Promise(resolve => { release = resolve })
    let parked = false, unparked = false
    const originalLstat = fs.lstat
${spy}.mockImplementation(async (...args) => {
      if (String(args[0]) === dumpDir && !parked) {
        parked = true
        enter()
        await released
        unparked = true
      }
      return originalLstat(...args)
    })`)
const barrier = '    await firstSweep'
assert(body.includes(barrier), 'interval test joins its first sweep')
body = body.replace(barrier, `    await entered
    expect(parked).toBe(true)
    expect(unparked).toBe(false)
    expect(await readdir(dumpDir)).toContain(dumpArtifactName(2))
    expect(await readdir(dumpDir)).not.toContain(dumpArtifactName(1))
    release()
${barrier}
    expect(unparked).toBe(true)`)
const addArtifact = "    await writeAged(join(dumpDir, dumpArtifactName(1)), '12345678', 1_000)"
assert(body.includes(addArtifact), 'original synthetic artifact insertion exists')
body = body.replace(addArtifact, `    expect(unparked).toBe(true)
${addArtifact}`)
source = source.slice(0, start) + body + source.slice(end)
source = source.replace(/(from\s*|import\s*\()(['"])(\.[^'"]+)\2/g,
  (_match, prefix, _quote, path) => `${prefix}${JSON.stringify(resolve(dirname(original), path))}`)
const dir = await mkdtemp(resolve('test/.scratch-dump-overlap-'))
try {
  const path = join(dir, 'overlap.test.ts')
  await writeFile(path, source)
  const child = spawnSync(process.execPath, ['test', path, '-t', title], { encoding: 'utf8' })
  const output = child.stdout + child.stderr
  console.log(output)
  assert.equal(child.status, 0, 'the joined interval test must pass')
  assert(output.includes(`(pass) dump directory byte cap > ${title}`), 'the interval test passed')
  assert(!output.includes('this test timed out'), 'the probe reached the assertion rather than hanging')
  console.log('First-sweep overlap is impossible: the test joins filesystem completion before adding the aged artifact.')
} finally {
  await rm(dir, { recursive: true, force: true })
}
