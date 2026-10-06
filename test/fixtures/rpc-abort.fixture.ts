import { beforeEach, expect } from 'bun:test'
import { createServer } from 'node:http'
import { lifetimeHooks } from './lifetime-hooks.js'
import { TestLifetime } from './test-lifetime.js'

// The uncancelled control must retain the old runner-facing promise. Otherwise
// named late-outcome reporting would mask the RPC cancellation control's leak.
if (process.env.RPC_ABORT_LIFETIME !== '1') {
  TestLifetime.prototype.runnerBody = function (body) {
    return this.tracked(body)
  }
}

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

// Prepare the pending request before Bun starts the body's 50 ms deadline.
// Otherwise a loaded runner can expire while fetch is still obtaining headers,
// and a supposed JSON cancellation control never reaches response.json().
const hooks = lifetimeHooks()
const { test, afterEach } = hooks
const legacy = new AbortController()
let timer: ReturnType<typeof setTimeout> | undefined
let phase: 'fetch' | 'json' = 'fetch'
let state: 'pending' | 'fulfilled' | 'rejected' = 'pending'
let pending: Promise<unknown>
let received!: () => void
const requestReceived = new Promise<void>((resolve) => {
  received = resolve
})
let ended = false
const server = createServer((_request, response) => {
  if (process.env.RPC_ABORT_PHASE === 'json') {
    response.writeHead(200, { 'content-type': 'application/json' })
    if (process.env.RPC_ABORT_IMMEDIATE === '1') {
      ended = true
      response.end('{}')
    } else response.flushHeaders()
  }
  received()
})

beforeEach(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('missing address')
  const request = fetch(`http://127.0.0.1:${address.port}`, {
    signal:
      process.env.RPC_ABORT_LIFETIME === '1'
        ? AbortSignal.any([legacy.signal, hooks.lifetime.signal])
        : legacy.signal,
  })
  identities.set(request, 'fetch')
  void request.catch(() => {})
  await requestReceived
  if (process.env.RPC_ABORT_PHASE === 'json') {
    const response = await request
    console.log('CONTROL headers')
    phase = 'json'
    pending = response.json()
    identities.set(pending, 'response.json')
  } else pending = request
  void pending.then(
    () => {
      state = 'fulfilled'
    },
    () => {
      state = 'rejected'
    },
  )
  // A completed server response must be consumed before checking the phase.
  // This makes the immediate-body negative control independent of scheduling.
  if (ended) await pending
})

afterEach(async () => {
  clearTimeout(timer)
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
test('a request outlives the runner deadline', async () => {
  if (process.env.RPC_ABORT_PHASE === 'json') {
    expect(phase).toBe('json')
    expect(state, 'JSON phase control requires a pending body').toBe('pending')
    expect(ended, 'JSON response must be withheld until cancellation').toBe(
      false,
    )
  } else expect(phase).toBe('fetch')
  console.log(`CONTROL ${phase} pending`)
  // Start the old timer only after the required await is demonstrably pending.
  // It still expires after Bun's body deadline; lifetime cancellation is earlier.
  timer = setTimeout(
    () =>
      legacy.abort(
        new DOMException('The operation timed out.', 'TimeoutError'),
      ),
    100,
  )
  try {
    await pending
  } catch (error) {
    console.log(`CONTROL ${phase} rejection`, String(error))
    if (process.env.RPC_ABORT_CATCH !== '1') throw error
  }
}, 50)
