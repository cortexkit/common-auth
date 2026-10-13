import { AsyncLocalStorage } from 'node:async_hooks'

const contexts = new AsyncLocalStorage()
let sequence = 0
export let watchdogFailures = 0

export function errorDetails(error, depth = 0) {
  if (!error || typeof error !== 'object') return { message: String(error) }
  const fields = {}
  for (const key of [
    'name',
    'message',
    'stack',
    'code',
    'errno',
    'win32Code',
    'reason',
    'path',
    'stage',
    'published',
    'attempts',
    'elapsedMs',
  ]) {
    if (error[key] !== undefined) fields[key] = error[key]
  }
  if (error.cause && depth < 3)
    fields.cause = errorDetails(error.cause, depth + 1)
  return fields
}

export function progress(event, fields = {}) {
  const state = contexts.getStore()
  const record = { event, test: state?.name, ...fields }
  if (state?.onEvent) state.onEvent(record)
  else console.log(JSON.stringify(record))
}

export function timedOut() {
  return contexts.getStore()?.expired === true
}

export function ownChild(child) {
  const state = contexts.getStore()
  state?.children.add(child)
  child.once('exit', () => state?.children.delete(child))
}

/** Cancels the test's wait, not an in-flight native IO transaction. */
export async function pending(label, operation) {
  const state = contexts.getStore()
  if (!state) return operation()
  if (state.expired) throw state.error
  const id = ++sequence
  const start = performance.now()
  state.pending.set(id, { label, start })
  progress('await-start', { label })
  let cancel
  const aborted = new Promise((_resolve, reject) => {
    cancel = () => reject(state.error)
    state.abort.signal.addEventListener('abort', cancel, { once: true })
  })
  const work = Promise.resolve().then(operation)
  try {
    const result = await Promise.race([work, aborted])
    progress('await-finish', { label, elapsedMs: performance.now() - start })
    return result
  } catch (error) {
    progress('await-fail', {
      label,
      elapsedMs: performance.now() - start,
      error: errorDetails(error),
    })
    throw error
  } finally {
    state.pending.delete(id)
    state.abort.signal.removeEventListener('abort', cancel)
  }
}

export async function withWatchdog(name, timeoutMs, body, onEvent) {
  const state = {
    name,
    pending: new Map(),
    children: new Set(),
    abort: new AbortController(),
    expired: false,
    error: undefined,
    onEvent,
  }
  return contexts.run(state, async () => {
    progress('test-start', { timeoutMs })
    let timer
    const expiry = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        state.expired = true
        watchdogFailures++
        const awaits = [...state.pending.values()].map(({ label, start }) => ({
          label,
          elapsedMs: performance.now() - start,
        }))
        state.error = new Error(
          `Windows test watchdog expired: ${name}; pending: ${awaits.map((entry) => entry.label).join(', ') || 'unlabelled test body'}`,
        )
        progress('WATCHDOG', { timeoutMs, awaits })
        state.abort.abort()
        for (const child of state.children) child.kill()
        reject(state.error)
      }, timeoutMs)
    })
    const work = Promise.resolve().then(body)
    try {
      await Promise.race([work, expiry])
      progress('test-pass')
    } catch (error) {
      progress('test-fail', { error: errorDetails(error) })
      throw error
    } finally {
      clearTimeout(timer)
      for (const child of state.children) child.kill()
    }
  })
}
