// A separate process that takes the same lock as the test that spawns it and
// increments a counter under it. It records whether it found another holder's
// "occupied" directory, which a holder creates for the length of its critical
// section, so the parent can tell whether two holders ever overlapped.
// Usage: bun lock-third-writer.ts <scratch dir> <timeoutMs>
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withLock, writeJsonAtomic } from '../../src/fs/index.js'

const [dir, timeoutArg] = process.argv.slice(2)
if (!dir || !timeoutArg) throw new Error('usage: <dir> <timeoutMs>')
const target = join(dir, 'data.json')
const observations = await withLock(
  target,
  { name: 'probe', ttlMs: 60_000, timeoutMs: Number(timeoutArg), renew: false },
  async (lock) => {
    await lock.assertOwned()
    let collision = false
    try {
      await mkdir(join(dir, 'occupied'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      collision = true
    }
    const data = JSON.parse(await readFile(target, 'utf8'))
    await writeJsonAtomic(
      target,
      { counter: data.counter + 1 },
      { beforeRename: () => lock.assertOwned() },
    )
    if (!collision) await rm(join(dir, 'occupied'), { recursive: true })
    return { acquired: true, collision }
  },
)
await writeFile(join(dir, 'third.json'), JSON.stringify(observations))
