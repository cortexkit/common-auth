import { describe, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'
import { PrivateFileError } from '../../src/fs/private-files.js'
import {
  isChangingLockRecord,
  LockContentionError,
  LockOwnershipError,
  lockPathFor,
} from '../../src/fs/with-lock.js'
import { rethrowSettingsLockError } from '../../src/settings/lock-errors.js'
import { SettingsRefusal } from '../../src/settings/refusal.js'

const target = resolve('settings.jsonc')
const name = 'settings-write'
const record = lockPathFor(target, name)

function mapped(error: unknown, lockTarget = target, lockName = name): unknown {
  try {
    rethrowSettingsLockError(error, lockTarget, lockName)
  } catch (caught) {
    return caught
  }
  throw new Error('Expected lock error mapper to throw')
}

function expectRefusal(error: unknown, code: SettingsRefusal['code']): void {
  const result = mapped(error)
  expect(result).toBeInstanceOf(SettingsRefusal)
  expect(result).toMatchObject({ code, cause: error })
}

describe('settings lock errors', () => {
  test('lock contention becomes settings-busy with its cause', () => {
    expectRefusal(
      new LockContentionError({ target, name, timeoutMs: 1 }),
      'settings-busy',
    )
  })

  test.each(['safe-parent', 'directory'])(
    '%s folder refusal becomes settings-unavailable',
    (stage) => {
      expectRefusal(
        new PrivateFileError(record, stage, {
          code: 'ERR_PRIVATE_FILES_SECURITY',
          reason: 'unsafe-parent',
        }),
        'settings-unavailable',
      )
    },
  )

  test('lost lock ownership is rethrown unchanged', () => {
    const error = new LockOwnershipError({ target, name })
    expect(mapped(error)).toBe(error)
  })

  test('verify security errors are rethrown unchanged', () => {
    const error = new PrivateFileError(record, 'verify', {
      code: 'ERR_PRIVATE_FILES_SECURITY',
      reason: 'wrong-owner',
    })
    expect(mapped(error)).toBe(error)
  })

  test('unrelated errors, including non-errors, are rethrown unchanged', () => {
    for (const error of [new Error('fault'), null, undefined, 'fault']) {
      expect(mapped(error)).toBe(error)
    }
  })

  test.each(['read', 'verify', 'create', 'directory-create'])(
    '%s persistent IO failures are rethrown unchanged',
    (stage) => {
      const error = new PrivateFileError(record, stage, {
        code: 'EIO',
        reason: 'io-error',
        win32Code: 1117,
      })
      expect(mapped(error)).toBe(error)
    },
  )

  test('sharing violations on another path are rethrown unchanged', () => {
    const error = new PrivateFileError(resolve('unrelated.lock'), 'read', {
      reason: 'io-error',
      win32Code: 32,
    })
    expect(mapped(error)).toBe(error)
  })

  test.skipIf(process.platform === 'win32')(
    'Windows sharing metadata is not treated as contention on POSIX',
    () => {
      const error = new PrivateFileError(record, 'read', {
        reason: 'io-error',
        win32Code: 32,
      })
      expect(mapped(error)).toBe(error)
    },
  )

  test.skipIf(process.platform !== 'win32')(
    'Windows changing-record errors use the failing lock target and name',
    () => {
      const source = resolve('legacy.json')
      const sourceName = 'save'
      const sourceRecord = lockPathFor(source, sourceName)
      for (const path of [sourceRecord, join(sourceRecord, 'owner.json')]) {
        for (const stage of ['read', 'verify']) {
          const error = new PrivateFileError(path, stage, {
            reason: 'io-error',
            win32Code: 32,
          })
          expect(isChangingLockRecord(error, source, sourceName)).toBe(true)
          const result = mapped(error, source, sourceName)
          expect(result).toBeInstanceOf(SettingsRefusal)
          expect(result).toMatchObject({ code: 'settings-busy', cause: error })
          expect(mapped(error)).toBe(error)
          expect(mapped(error, source, 'different-name')).toBe(error)
        }
      }
    },
  )

  test.skipIf(process.platform !== 'win32')(
    'Windows access-denied creates use the failing lock record paths',
    () => {
      for (const [path, stage] of [
        [record, 'create'],
        [`${record}.evicting`, 'directory-create'],
      ]) {
        const error = new PrivateFileError(path as string, stage as string, {
          reason: 'io-error',
          win32Code: 5,
        })
        expect(isChangingLockRecord(error, target, name)).toBe(true)
        expectRefusal(error, 'settings-busy')
      }
    },
  )
})
