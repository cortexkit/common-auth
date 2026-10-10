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
