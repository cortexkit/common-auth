import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaustrumCredentialError } from '@cortexkit/claustrum-client'
import type { ClaustrumEnrollmentConnection } from '../../src/claustrum/index.js'
import {
  connectSetupHost,
  HostNotEnrolledError,
} from '../../src/setup/enroll.js'
import {
  runSetup,
  type SetupIO,
  setupEnrollment,
} from '../../src/setup/index.js'
import { fakeIO, plugin, terminal } from './helpers.js'

const roots: string[] = []
// The overall enrollment wait: five minutes, the length of the 300 one-second
// polls setup always made, now measured on the clock.
const WAIT_MS = 300_000
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})
async function profile() {
  const root = await mkdtemp(join(tmpdir(), 'common-auth-setup-enroll-'))
  roots.push(root)
  return root
}

/** A fake clock that each wait advances, so the overall bound runs instantly. */
function clock(): Pick<SetupIO, 'now' | 'wait'> & { waits: number[] } {
  let time = 0
  const waits: number[] = []
  return {
    waits,
    now: () => time,
    async wait(ms) {
      waits.push(ms)
      time += ms
    },
  }
}

function vault(
  overrides: Partial<ClaustrumEnrollmentConnection>,
): ClaustrumEnrollmentConnection {
  return {
    close() {},
    async enrollPropose() {
      return { requestId: 'request-1' }
    },
    async enrollPoll() {
      return { status: 'pending' }
    },
    ...overrides,
  }
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('enrollment did not fail')
}

const unsupported = () =>
  new ClaustrumCredentialError('unknown_method', 'transient', 'retry')

describe('setup enrollment wait', () => {
  test('a proposal refused with unknown_method stops after one attempt with the fixed message', async () => {
    const root = await profile()
    const time = clock()
    let proposals = 0
    const term = terminal()
    const error = await rejection(
      connectSetupHost(
        plugin(root),
        'opencode',
        {
          ...time,
          connect: async () =>
            vault({
              async enrollPropose() {
                proposals++
                throw unsupported()
              },
            }),
        },
        term,
        async () => {},
      ),
    )
    expect(error).toBeInstanceOf(HostNotEnrolledError)
    expect(error.message).toBe(
      'This Claustrum vault does not support connecting plugins yet, so setup cannot connect to it. Run setup without --claustrum to use local accounts.',
    )
    expect(error).toMatchObject({
      reason: 'unsupported-vault',
      lastErrorCode: 'unknown_method',
    })
    expect(proposals).toBe(1)
    expect(time.waits).toEqual([])
  })

  test('setup reports an unsupported vault with the fixed message and the host not connected', async () => {
    const root = await profile()
    const p = plugin(root)
    const io = fakeIO()
    io.env = { PATH: '/bin', OPENCODE_CONFIG_DIR: join(root, 'config') }
    io.files.set('/bin/opencode', '')
    io.files.set('/bin/ck', '')
    io.files.set(p.vault.connectionFile, '{}')
    Object.assign(io, clock())
    io.connect = async () =>
      vault({
        async enrollPropose() {
          throw unsupported()
        },
      })
    const term = terminal()
    const error = await rejection(
      runSetup(p, ['--yes', '--claustrum'], { ...io, terminal: term }),
    )
    expect(error.message).toBe(
      'This Claustrum vault does not support connecting plugins yet, so setup cannot connect to it. Run setup without --claustrum to use local accounts.',
    )
    expect(setupEnrollment(error)).toEqual([
      { host: 'opencode', outcome: 'not-enrolled' },
    ])
    expect(term.lines.join('')).toContain(
      'Asking the vault to connect test-auth-opencode…\n',
    )
  })

  test('a retryable proposal failure backs off and stops at the overall bound naming its code', async () => {
    const root = await profile()
    const time = clock()
    let proposals = 0
    const term = terminal()
    const error = await rejection(
      connectSetupHost(
        plugin(root),
        'opencode',
        {
          ...time,
          connect: async () =>
            vault({
              async enrollPropose() {
                proposals++
                throw new ClaustrumCredentialError(
                  'store_error',
                  'transient',
                  'retry',
                )
              },
            }),
        },
        term,
        async () => {},
      ),
    )
    expect(error).toBeInstanceOf(HostNotEnrolledError)
    expect(error.message).toBe(
      'The vault never created the enrollment request (last error: store_error). Check that ck is running, then rerun setup.',
    )
    expect(error).toMatchObject({
      reason: 'request-not-created',
      lastErrorCode: 'store_error',
    })
    expect(time.waits.slice(0, 7)).toEqual([
      1000, 2000, 4000, 8000, 16_000, 30_000, 30_000,
    ])
    expect(time.waits.reduce((sum, ms) => sum + ms, 0)).toBe(WAIT_MS)
    // One proposal per pause, plus the last one at the bound.
    expect(proposals).toBe(time.waits.length + 1)
    expect(proposals).toBeLessThan(20)
    const printed = term.lines.join('')
    expect(printed).toContain(
      'The vault has not created the request yet (store_error); retrying.\n',
    )
    // Said once, not once per attempt.
    expect(printed.split('retrying.').length).toBe(2)
    expect(printed).not.toContain('ck auth enroll approve')
  })

  test('a progress line prints before the first proposal', async () => {
    const root = await profile()
    const term = terminal()
    let before: string | undefined
    await connectSetupHost(
      plugin(root),
      'opencode',
      {
        ...clock(),
        connect: async () =>
          vault({
            async enrollPropose() {
              before ??= term.lines.join('')
              return { requestId: 'request-1' }
            },
            async enrollPoll() {
              return {
                status: 'approved',
                token: 'f'.repeat(64),
                tokenGeneration: 1,
                name: 'test-auth-opencode',
              }
            },
          }),
      },
      term,
      async () => {},
    )
    expect(before).toBe('Asking the vault to connect test-auth-opencode…\n')
  })

  test('a request still waiting for approval at the bound repeats the approve command', async () => {
    const root = await profile()
    const time = clock()
    const term = terminal()
    let polls = 0
    const error = await rejection(
      connectSetupHost(
        plugin(root),
        'opencode',
        {
          ...time,
          connect: async () =>
            vault({
              async enrollPoll() {
                polls++
                return { status: 'pending' }
              },
            }),
        },
        term,
        async () => {},
      ),
    )
    expect(error).toBeInstanceOf(HostNotEnrolledError)
    expect(error.message).toBe(
      'Claustrum approval is still pending. In another terminal, run: ck auth enroll approve --request-id request-1 --name test-auth-opencode and then rerun setup.',
    )
    expect(error).toMatchObject({ reason: 'approval-pending' })
    expect(term.lines.join('')).toContain(
      'Waiting for approval. In another terminal, run:\n  ck auth enroll approve --request-id request-1 --name test-auth-opencode\n',
    )
    expect(time.waits.every((ms) => ms === 1000)).toBe(true)
    expect(time.waits.reduce((sum, ms) => sum + ms, 0)).toBe(WAIT_MS)
    expect(polls).toBe(time.waits.length + 1)
  })

  test('each tick of the wait checks the process fence once', async () => {
    const root = await profile()
    let fences = 0
    const fencesAtPoll: number[] = []
    let polls = 0
    await connectSetupHost(
      plugin(root),
      'opencode',
      {
        ...clock(),
        connect: async () =>
          vault({
            async enrollPoll() {
              fencesAtPoll.push(fences)
              return ++polls < 6
                ? { status: 'pending' }
                : {
                    status: 'approved',
                    token: 'f'.repeat(64),
                    tokenGeneration: 1,
                    name: 'test-auth-opencode',
                  }
            },
          }),
      },
      terminal(),
      async () => {
        fences++
      },
    )
    // One before connecting, then one per tick: the first tick also proposes.
    expect(fencesAtPoll).toEqual([2, 3, 4, 5, 6, 7])
    // Writing the approved token checks once more.
    expect(fences).toBe(8)
  })
})
