import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import {
  DisappearedLockRecordError,
  isWindowsAccessDeniedRead,
  readLockRecord,
} from '../../src/fs/lock-record.js'
import {
  isWindowsSharingViolation,
  PrivateFileError,
} from '../../src/fs/private-files.js'

const path = resolve('owner.json')
const denied = (stage = 'verify', win32Code = 5, errorPath = path) =>
  new PrivateFileError(errorPath, stage, {
    code: 'ERR_PRIVATE_FILES_SECURITY',
    reason: 'io-error',
    win32Code,
  })

test('access-denied lock read accepts only a successful fresh reread', async () => {
  let reads = 0
  const original = denied()
  const bytes = await readLockRecord(path, async () => {
    if (++reads === 1) throw original
    return 'verified owner'
  })
  expect(bytes).toBe('verified owner')
  expect(reads).toBe(2)
  expect(isWindowsSharingViolation(original)).toBe(false)
})

test('access-denied lock read requires fresh ENOENT to report disappearance', async () => {
  let reads = 0
  const original = denied()
  try {
    await readLockRecord(path, async () => {
      if (++reads === 1) throw original
      throw Object.assign(new Error('gone'), { code: 'ENOENT' })
    })
    throw new Error('expected a disappeared record')
  } catch (error) {
    expect(error).toBeInstanceOf(DisappearedLockRecordError)
    expect((error as DisappearedLockRecordError).code).toBe('ENOENT')
    expect((error as Error).cause).toBe(original)
  }
  expect(reads).toBe(2)
})

test('persistent access-denied lock read preserves the original refusal', async () => {
  let reads = 0
  const original = denied()
  const replacement = denied()
  await expect(
    readLockRecord(path, async () => {
      throw ++reads === 1 ? original : replacement
    }),
  ).rejects.toBe(original)
  expect(reads).toBe(2)
})

test('unrelated access refusals are not rechecked as deleting lock records', async () => {
  for (const error of [
    denied('create'),
    denied('remove'),
    denied('read', 1117),
    denied('read', 5, resolve('other-owner.json')),
    new PrivateFileError(path, 'verify', {
      reason: 'wrong-owner',
      win32Code: 5,
    }),
  ]) {
    let reads = 0
    expect(isWindowsAccessDeniedRead(error, [path])).toBe(false)
    await expect(
      readLockRecord(path, async () => {
        reads++
        throw error
      }),
    ).rejects.toBe(error)
    expect(reads).toBe(1)
  }
})
