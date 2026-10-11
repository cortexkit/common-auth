import { describe, expect, test } from 'bun:test'
import { combineAbortSignals } from '../../src/util/any-signal.js'

type EventCallback = NonNullable<Parameters<EventTarget['addEventListener']>[1]>

class CountedSignal extends EventTarget {
  aborted = false
  reason: unknown
  #abortListeners = new Set<EventCallback>()

  get abortListenerCount() {
    return this.#abortListeners.size
  }

  override addEventListener(
    type: string,
    callback: EventCallback | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (!callback) return
    if (type === 'abort') this.#abortListeners.add(callback)
    super.addEventListener(type, callback, options)
  }

  override removeEventListener(
    type: string,
    callback: EventCallback | null,
    options?: boolean | EventListenerOptions,
  ) {
    if (!callback) return
    if (type === 'abort') this.#abortListeners.delete(callback)
    super.removeEventListener(type, callback, options)
  }

  abort(reason: unknown) {
    if (this.aborted) return
    this.aborted = true
    this.reason = reason
    this.dispatchEvent(new Event('abort'))
  }

  asSignal(): AbortSignal {
    return this as unknown as AbortSignal
  }
}

describe('combineAbortSignals', () => {
  test('keeps the reason from the first signal that aborts', () => {
    const first = new AbortController()
    const second = new AbortController()
    const combined = combineAbortSignals([first.signal, second.signal])

    second.abort('second reason')
    first.abort('first reason')

    expect(combined.signal.aborted).toBe(true)
    expect(combined.signal.reason).toBe('second reason')
  })

  test('uses the first input reason when several inputs are already aborted', () => {
    const first = new AbortController()
    const second = new AbortController()
    first.abort('first reason')
    second.abort('second reason')

    const combined = combineAbortSignals([first.signal, second.signal])

    expect(combined.signal.aborted).toBe(true)
    expect(combined.signal.reason).toBe('first reason')
  })

  test('immediately aborts when an input is already aborted', () => {
    const source = new CountedSignal()
    source.abort('already stopped')

    const combined = combineAbortSignals([source.asSignal()])

    expect(combined.signal.aborted).toBe(true)
    expect(combined.signal.reason).toBe('already stopped')
    expect(source.abortListenerCount).toBe(0)
  })

  test('dispose removes every source listener across repeated combines', () => {
    const source = new CountedSignal()
    const combined = Array.from({ length: 100 }, () =>
      combineAbortSignals([source.asSignal()]),
    )

    expect(source.abortListenerCount).toBe(100)
    for (const item of combined) item.dispose()
    expect(source.abortListenerCount).toBe(0)
  })
})
