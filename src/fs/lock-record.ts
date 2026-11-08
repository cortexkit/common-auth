import { resolve } from 'node:path'
import { PrivateFileError } from './private-files.js'

/** A failed open is not evidence of deletion until the same path disappears. */
export class DisappearedLockRecordError extends Error {
  readonly code = 'ENOENT'

  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(`Lock record disappeared: ${path}`, { cause })
  }
}

export function isWindowsAccessDeniedRead(
  error: unknown,
  paths: readonly string[],
): error is PrivateFileError {
  return (
    error instanceof PrivateFileError &&
    error.reason === 'io-error' &&
    error.win32Code === 5 &&
    (error.stage === 'read' || error.stage === 'verify') &&
    paths.some((path) => resolve(path) === error.path)
  )
}

export async function readLockRecord<T>(
  path: string,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (!isWindowsAccessDeniedRead(error, [path])) throw error
    // Windows commonly maps STATUS_DELETE_PENDING to ACCESS_DENIED (5),
    // which can also mean a permission refusal, not a sharing violation.
    // Only a successful fresh read or ENOENT resolves that ambiguity. A
    // persistent refusal escapes to the caller's existing deadline/backoff.
    try {
      return await read()
    } catch (recheckError) {
      if ((recheckError as NodeJS.ErrnoException).code === 'ENOENT')
        throw new DisappearedLockRecordError(path, error)
      throw error
    }
  }
}
