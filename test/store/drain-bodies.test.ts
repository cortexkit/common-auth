import { expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { drainBodies } from './drain-bodies.js'
import { deferred, oauth, scenario } from './helpers.js'

it('teardown keeps a delayed body and its own scenario alive through its final state read', async () => {
  const original = await scenario()
  const successor = await scenario()
  const released = deferred()
  const readAllowed = deferred()
  const terminal = deferred()
  let current = original
  const captured = current
  const reads: string[] = []
  try {
    await original.open().add({ id: 'a', credential: oauth('original') })
    await successor.open().add({ id: 'a', credential: oauth('successor') })
    const body = (async () => {
      await released.promise
      await readAllowed.promise
      try {
        reads.push((await captured.state())?.accounts.a.refresh ?? 'missing')
      } finally {
        terminal.resolve()
      }
    })()
    let deletedBeforeTerminal = false
    let finished = false
    const teardown = drainBodies([() => released.resolve()], [body], () => {
      deletedBeforeTerminal = reads.length === 0
      captured.cleanup()
      finished = true
    })
    await released.promise
    current = successor
    // Hold the body after provider release but before its final filesystem read.
    expect(finished).toBe(false)
    expect(existsSync(original.statePath)).toBe(true)
    expect(reads).toEqual([])
    readAllowed.resolve()
    await terminal.promise
    await teardown
    expect(deletedBeforeTerminal).toBe(false)
    expect(reads).toEqual(['original'])
    expect((await current.state()).accounts.a.refresh).toBe('successor')
  } finally {
    readAllowed.resolve()
    original.cleanup()
    successor.cleanup()
  }
})
