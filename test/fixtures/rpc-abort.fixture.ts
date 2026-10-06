import { createServer } from 'node:http'
import { lifetimeHooks } from './lifetime-hooks.js'
import { TestLifetime } from './test-lifetime.js'

const identities = new WeakMap<Promise<unknown>, string>()
const tracked = TestLifetime.prototype.tracked
TestLifetime.prototype.tracked = function (body) {
  const pending = tracked.call(this, () => {
    const raw = body()
    if (raw instanceof Promise) identities.set(raw, 'raw body')
    return raw
  })
  identities.set(pending, 'tracked body returned to runner')
  void pending.then(
    () => console.log('CONTROL tracked body fulfilled'),
    (error) =>
      console.log('CONTROL tracked body rejection observed', String(error)),
  )
  return pending
}
process.on('unhandledRejection', (error, promise) => {
  console.log(
    'CONTROL unhandled identity',
    identities.get(promise) ?? 'other',
    String(error),
  )
})

// Short budgets exercise a runner-abandoned body without changing any existing
// test timeout. The fetch case withholds headers; the JSON case sends headers
// but withholds the rest of the body, so each await can be aborted separately.
const hooks = lifetimeHooks()
const { test, afterEach } = hooks
const server = createServer((_request, response) => {
  if (process.env.RPC_ABORT_PHASE === 'json') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.write('{')
  }
})
afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
test('a request outlives the runner deadline', async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('missing address')
  let phase = 'fetch'
  try {
    const pending = fetch(`http://127.0.0.1:${address.port}`, {
      signal:
        process.env.RPC_ABORT_LIFETIME === '1'
          ? AbortSignal.any([AbortSignal.timeout(100), hooks.lifetime.signal])
          : AbortSignal.timeout(100),
    })
    identities.set(pending, 'fetch')
    const response = await pending
    console.log('CONTROL headers')
    phase = 'json'
    const body = response.json()
    identities.set(body, 'response.json')
    await body
  } catch (error) {
    console.log(`CONTROL ${phase} rejection`, String(error))
    if (process.env.RPC_ABORT_CATCH !== '1') throw error
  }
}, 50)
