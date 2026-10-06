import { afterAll, test as bunTest } from 'bun:test'
import { lifetimeHooks } from './lifetime-hooks.js'

const hooks = lifetimeHooks(200)
hooks.afterEach(() => {}, 200)
if (process.env.HOOK_OVERRUN_UNRELATED === '1') afterAll(() => Bun.sleep(200))
if (process.env.HOOK_OVERRUN_PREABORT === '1') {
  const name = 'intentional body resumes after cancellation'
  hooks.test(
    name,
    async () => {
      // Resume after the 20 ms deadline, when teardown has already cancelled.
      await Bun.sleep(100)
      if (process.env.HOOK_OVERRUN_PREABORT_LISTENER === '1') {
        const signal = hooks.lifetime.signal
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        )
      } else await hooks.lifetime.untilCancelled()
    },
    20,
  )
  hooks.test('successor remains observable', () => {
    console.log('successor setup was allowed')
  })
} else if (process.env.HOOK_OVERRUN_NORMAL === '1') {
  hooks.test('normal body has no late outcome', async () => {
    if (process.env.HOOK_OVERRUN_UNRELATED === '1') {
      void Bun.sleep(150).then(() => {
        throw new Error('unrelated late rejection')
      })
    }
    await Bun.sleep(100)
    if (process.env.HOOK_OVERRUN_NORMAL_REJECT === '1')
      throw new Error('ordinary body assertion')
  })
} else {
  const name = 'intentional body outlives its hook'
  const body = async () => {
    await Bun.sleep(600)
    if (process.env.HOOK_OVERRUN_FULFILL !== '1')
      throw new Error('owned late assertion')
  }
  if (process.env.HOOK_OVERRUN_CONTROL === '1') {
    bunTest(name, () => hooks.lifetime.tracked(body), 20)
  } else {
    hooks.test(name, body, 20)
  }
  hooks.test('successor remains observable', () => {
    console.log('successor setup was allowed')
  })
}
