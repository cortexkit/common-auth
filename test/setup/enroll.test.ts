import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaustrumCredentialError } from '@cortexkit/claustrum-client'
import type { ClaustrumEnrollmentConnection } from '../../src/claustrum/index.js'
import { VAULT_HOST_CONNECT_REFUSAL } from '../../src/claustrum/index.js'
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

test('hosted setup and Connect refuse with Served by Thalamus before any enrollment', async () => {
  const root = await profile()
  const previous = process.env.CORTEXKIT_VAULT_HOST
  process.env.CORTEXKIT_VAULT_HOST = 'thalamus'
  try {
    const connect = mock(async () => vault({}))
    const fence = mock(async () => {})
    const setup = plugin(root)
    setup.signInLocal = mock(async () => {})
    const io = { ...fakeIO(root), connect }
    const direct = await rejection(
      connectSetupHost(setup, 'opencode', io, terminal(), fence),
    )
    expect(direct.message).toBe(VAULT_HOST_CONNECT_REFUSAL)
    for (const argv of [
      ['--claustrum', '--yes'],
      ['--enroll-only', '--yes'],
      ['--no-claustrum', '--yes'],
    ]) {
      const error = await rejection(runSetup(setup, argv, io))
      expect(error.message).toBe('Served by Thalamus')
    }
    expect(connect).not.toHaveBeenCalled()
    expect(fence).not.toHaveBeenCalled()
    expect(setup.signInLocal).not.toHaveBeenCalled()
  } finally {
    if (previous === undefined) delete process.env.CORTEXKIT_VAULT_HOST
    else process.env.CORTEXKIT_VAULT_HOST = previous
  }
})

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
      'This Claustrum vault is too old to connect plugins. Run ck upgrade to move to Claustrum v0.2.0 or newer (read "Upgrading from v0.1.3" in its release notes first), or run setup without --claustrum to use local accounts.',
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
      'This Claustrum vault is too old to connect plugins. Run ck upgrade to move to Claustrum v0.2.0 or newer (read "Upgrading from v0.1.3" in its release notes first), or run setup without --claustrum to use local accounts.',
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

  test('an already approved host prints its approved name instead of the proposed name', async () => {
    const root = await profile()
    let proposals = 0
    let polls = 0
    let closed = 0
    const io = {
      ...clock(),
      connect: async () =>
        vault({
          close() {
            closed++
          },
          async enrollPropose() {
            proposals++
            return { requestId: 'request-1' }
          },
          async enrollPoll() {
            polls++
            return {
              status: 'approved',
              token: 'f'.repeat(64),
              tokenGeneration: 1,
              name: 'operator-approved-host',
            }
          },
        }),
    }
    await connectSetupHost(
      plugin(root),
      'opencode',
      io,
      terminal(),
      async () => {},
    )

    const term = terminal()
    await connectSetupHost(plugin(root), 'opencode', io, term, async () => {})

    expect(term.lines.join('')).toBe(
      'Already connected as operator-approved-host.\n',
    )
    expect(proposals).toBe(1)
    expect(polls).toBe(1)
    expect(closed).toBe(2)
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
