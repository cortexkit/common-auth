import { afterAll, expect, mock, test } from 'bun:test'
import * as realChildProcess from 'node:child_process'
import { EventEmitter } from 'node:events'

const real = { ...realChildProcess }
// Bun's module mocks are process-wide; put the real module back for the test
// files that run after this one.
afterAll(() => {
  mock.module('node:child_process', () => real)
})

// A child that never starts emits 'error' and has no pid. Node documents no
// guarantee that 'close' follows, so this stub never emits it: the runner must
// settle on the 'error' alone instead of waiting for a process that doesn't
// exist (and that its timer could never kill).
mock.module('node:child_process', () => ({
  spawn: () => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number | undefined
      stdout: EventEmitter
      stderr: EventEmitter
      kill: () => boolean
    }
    child.pid = undefined
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => false
    queueMicrotask(() =>
      child.emit(
        'error',
        Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' }),
      ),
    )
    return child
  },
}))

const { defaultCommandRunner } = await import('../../src/setup/command-runner')

test('a command that never starts settles on its spawn error without a close event', async () => {
  const result = await Promise.race([
    defaultCommandRunner.run('npm', ['install'], { timeoutMs: 0 }),
    new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1_000)),
  ])
  expect(result).not.toBe('hung')
  if (result === 'hung') return
  expect(result.spawnError).toBe(true)
  expect(result.exitCode).toBe(1)
  expect(result.timedOut).toBe(false)
})
