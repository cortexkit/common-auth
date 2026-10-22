import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { connectClaustrumEnrollmentClient } from '../../src/claustrum/index.ts'
import {
  connectSetupHost,
  HostNotEnrolledError,
} from '../../src/setup/enroll.ts'
import type { SetupIO } from '../../src/setup/types.ts'
import { plugin, terminal } from '../setup/helpers.ts'
import { cleanupDirs, clientKeepsDefinitiveErrors, tempDir } from './helpers.ts'
import { type MockDaemon, startMockDaemon } from './mock-daemon.ts'

// These run setup's enrollment against the real claustrum-client and a daemon
// that answers the proposal the way every published vault does. CI's
// claustrum-floor job runs this folder again with claustrum-client 0.6.2.

/** Setup's overall enrollment wait: five minutes. */
const WAIT_MS = 300_000

const daemons: MockDaemon[] = []
afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await cleanupDirs()
})

async function vault(mode: MockDaemon['enrollment']) {
  const root = await tempDir('claustrum-unsupported-')
  const daemon = await startMockDaemon({ directory: root })
  daemons.push(daemon)
  daemon.enrollment = mode
  const p = plugin(root)
  p.vault.connectionFile = daemon.connectionFile
  // A fake clock: each wait advances it, so the overall bound is reached
  // without sleeping.
  let clock = 0
  const waits: number[] = []
  const io: SetupIO = {
    now: () => clock,
    async wait(ms) {
      waits.push(ms)
      clock += ms
    },
    connect: (options) =>
      connectClaustrumEnrollmentClient({ ...options, logger: () => {} }),
  }
  return { root, daemon, p, io, waits }
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('enrollment did not fail')
}

test('a vault that answers the proposal with unknown_method stops setup after one proposal', async () => {
  const { root, daemon, p, io, waits } = await vault('unknown_method')
  let proposals = 0
  const term = terminal()
  const error = await rejection(
    connectSetupHost(
      p,
      'opencode',
      {
        ...io,
        connect: async (options) => {
          const client = await io.connect?.(options)
          if (!client) throw new Error('no client')
          return {
            ...client,
            close: () => client.close(),
            enrollPoll: (input) => client.enrollPoll(input),
            enrollPropose: (input) => {
              proposals++
              return client.enrollPropose(input)
            },
          }
        },
      },
      term,
      async () => {},
    ),
  )
  expect(error).toBeInstanceOf(HostNotEnrolledError)
  expect(error.message).toBe(
    'This Claustrum vault is too old to connect plugins. Update Claustrum to v0.2.0 or newer, or run setup without --claustrum to use local accounts.',
  )
  expect(error).toMatchObject({
    reason: 'unsupported-vault',
    lastErrorCode: 'unknown_method',
  })
  // Clients before 0.13 may repeat the refused proposal while reconnecting.
  expect(proposals).toBe(1)
  if (clientKeepsDefinitiveErrors) {
    expect(daemon.proposals).toHaveLength(1)
  } else {
    expect(daemon.proposals.length).toBeGreaterThanOrEqual(1)
    expect(daemon.proposals.length).toBeLessThanOrEqual(2)
  }
  expect(waits).toEqual([])
  expect(term.lines.join('')).toBe(
    'Asking the vault to connect test-auth-opencode…\n',
  )
  // The vault holds no request, so no enrollment state is left behind: status
  // reads as not enrolled, and a reset or the next run starts afresh.
  expect(
    existsSync(join(root, 'vault', 'opencode-enrollment-state.json')),
  ).toBe(false)
})

test('an enrollment that fails unexpectedly reports a named, fixed error with only a vetted code', async () => {
  const { p, io } = await vault('unknown_method')
  const secret = 'request-secret-0123456789abcdef'
  const error = await rejection(
    connectSetupHost(
      p,
      'opencode',
      {
        ...io,
        connect: async (options) => {
          const client = await io.connect?.(options)
          if (!client) throw new Error('no client')
          return {
            ...client,
            close: () => client.close(),
            enrollPropose: () =>
              Promise.reject(
                Object.assign(new Error(`boom ${secret}`), {
                  code: 'internal_fault',
                }),
              ),
          }
        },
      },
      terminal(),
      async () => {},
    ),
  )
  expect(error).toBeInstanceOf(HostNotEnrolledError)
  expect(error.message).toBe(
    'Claustrum enrollment did not complete. Inspect and approve with ck, then rerun setup.',
  )
  expect(error).toMatchObject({
    reason: 'incomplete',
    lastErrorCode: 'internal_fault',
  })
  expect(String(error.message)).not.toContain(secret)
})

test('an unknown_method proposal preserves each client version’s failure behavior', async () => {
  // Before 0.13, a refused call triggers a reconnect. If that reconnect fails,
  // the client reports transport_error and setup backs off to its overall wait.
  // From 0.13 on, unknown_method is definitive, so setup stops immediately.
  const { daemon, p, io, waits } = await vault(
    'unknown_method-then-unreachable',
  )
  const term = terminal()
  const error = await rejection(
    connectSetupHost(p, 'opencode', io, term, async () => {}),
  )
  expect(error).toBeInstanceOf(HostNotEnrolledError)

  if (clientKeepsDefinitiveErrors) {
    expect(error.message).toBe(
      'This Claustrum vault is too old to connect plugins. Update Claustrum to v0.2.0 or newer, or run setup without --claustrum to use local accounts.',
    )
    expect(error).toMatchObject({
      reason: 'unsupported-vault',
      lastErrorCode: 'unknown_method',
    })
    expect(waits).toEqual([])
    expect(daemon.proposals).toHaveLength(1)
    expect(term.lines.join('')).toBe(
      'Asking the vault to connect test-auth-opencode…\n',
    )
    return
  }

  expect(error.message).toBe(
    'The vault never created the enrollment request (last error: transport_error). Check that ck is running, then rerun setup.',
  )
  expect(error).toMatchObject({
    reason: 'request-not-created',
    lastErrorCode: 'transport_error',
  })
  expect(waits.reduce((sum, ms) => sum + ms, 0)).toBe(WAIT_MS)
  expect(waits.slice(0, 7)).toEqual([
    1000, 2000, 4000, 8000, 16_000, 30_000, 30_000,
  ])
  // Backed off: far fewer proposals than one per second. Each one still
  // reaches the vault over the first connection; only the client's failed
  // reconnect afterwards turns the refusal into transport_error.
  expect(waits.length).toBeLessThan(20)
  expect(daemon.proposals.length).toBe(waits.length + 1)
  expect(term.lines.join('')).toContain(
    'The vault has not created the request yet (transport_error); retrying.',
  )
})
