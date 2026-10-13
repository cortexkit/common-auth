import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import {
  errorDetails,
  ownChild,
  pending,
  timedOut,
  withWatchdog,
} from '../windows/watchdog.mjs'

test('Windows watchdog names the test and pending await then rejects', async () => {
  const records = []
  await expect(
    withWatchdog(
      'lease watchdog fixture',
      20,
      () => pending('lease renewal callback', () => new Promise(() => {})),
      (record) => records.push(record),
    ),
  ).rejects.toThrow('pending: lease renewal callback')
  const expired = records.find((record) => record.event === 'WATCHDOG')
  expect(expired.test).toBe('lease watchdog fixture')
  expect(expired.awaits.map((entry) => entry.label)).toEqual([
    'lease renewal callback',
  ])
  expect(records.some((record) => record.event === 'test-fail')).toBe(true)
})

test('Windows watchdog cancels the caller wait and kills its own helper', async () => {
  let killed = false
  let bodyCancelled = false
  const child = new EventEmitter()
  child.kill = () => {
    killed = true
    child.emit('exit', 1)
  }
  await expect(
    withWatchdog(
      'helper watchdog fixture',
      20,
      async () => {
        ownChild(child)
        try {
          await pending('second-user probe', () => new Promise(() => {}))
        } finally {
          bodyCancelled = timedOut()
        }
      },
      () => {},
    ),
  ).rejects.toThrow('second-user probe')
  await Promise.resolve()
  expect(killed).toBe(true)
  expect(bodyCancelled).toBe(true)
})

test('Windows watchdog reports original native error fields and successful awaits', async () => {
  const records = []
  await withWatchdog(
    'completed fixture',
    100,
    () => pending('rename', async () => {}),
    (record) => records.push(record),
  )
  expect(records.map((record) => record.event)).toEqual([
    'test-start',
    'await-start',
    'await-finish',
    'test-pass',
  ])
  expect(
    errorDetails(
      Object.assign(new Error('sharing refusal'), {
        code: 'EBUSY',
        win32Code: 32,
        stage: 'rename',
      }),
    ),
  ).toMatchObject({ code: 'EBUSY', win32Code: 32, stage: 'rename' })
})
