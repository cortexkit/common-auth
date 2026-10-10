import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createPiSlot } from '../../src/pi-slot/slot.js'

// Deep imports are confined to tests: Pi does not export the mutable store from its root.
const root = fileURLToPath(
  new URL(
    '../../node_modules/@earendil-works/pi-coding-agent/dist/core/',
    import.meta.url,
  ),
)
const { AuthStorage } = await import(`${root}auth-storage.js`)
const [mode, authPath = '', stashPath = '', boundary = ''] =
  process.argv.slice(2)
const options = {
  authPath,
  stashPath,
  provider: 'openai-codex',
  placeholderKey: 'pi-vault-disabled',
}
const waitForParent = () =>
  new Promise<void>((resolve) => process.stdin.once('data', () => resolve()))

if (mode === 'pi-writer') {
  await AuthStorage.create(authPath).modify('anthropic', async () => {
    console.log('LOCKED')
    await waitForParent()
    return { type: 'api_key', key: 'foreign-provider-key' }
  })
} else if (mode === 'pi-sync-writer') {
  const modulePath =
    boundary === '0.86.1'
      ? '../../node_modules/pi-coding-agent-086/dist/core/auth-storage.js'
      : '../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js'
  const { FileAuthStorageBackend } = await import(
    fileURLToPath(new URL(modulePath, import.meta.url))
  )
  const backend = new FileAuthStorageBackend(authPath)
  const attempts: { elapsed: number; code: string }[] = []
  let acquired = 0
  const start = Date.now()
  // Repeat across the default 10s stale boundary, not just initial contention.
  while (Date.now() - start < 12_000) {
    try {
      backend.withLock(() => {
        acquired++
        return {
          result: undefined,
          next: JSON.stringify({
            anthropic: { type: 'api_key', key: 'intruder' },
          }),
        }
      })
      attempts.push({ elapsed: Date.now() - start, code: 'ACQUIRED' })
    } catch (error) {
      attempts.push({
        elapsed: Date.now() - start,
        code:
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : 'UNKNOWN',
      })
    }
    await Bun.sleep(100)
  }
  console.log(JSON.stringify({ acquired, attempts }))
} else if (mode === 'helper-holder') {
  // The durable boundary runs under the helper's lock. A synchronous pipe read lets
  // the parent launch Pi before releasing that boundary without a timing-only race.
  await createPiSlot(options, (step) => {
    if (step !== 'stash-written') return
    console.log('LOCKED')
    readFileSync(0)
  }).enterVault()
} else {
  const slot = createPiSlot(options, (step) => {
    if (step === boundary) process.exit(73)
  })
  if (mode === 'crash-enter') await slot.enterVault()
  else await slot.exitVault()
}
