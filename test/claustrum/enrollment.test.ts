import { describe, expect } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  ClaustrumCredentialError,
  writeEnrollmentTokenFile,
} from '@cortexkit/claustrum-client'
import {
  type ClaustrumEnrollmentClient,
  ClaustrumEnrollmentManager,
  classifyEnrollmentError,
  disconnectClaustrumEnrollment,
  enrollmentAuthority,
  enrollmentName,
  getClaustrumEnrollmentPaths,
  hostEnrollmentPaths,
  readClaustrumEnrollmentStatus,
  readClaustrumEnrollmentToken,
} from '../../src/claustrum/index.ts'
import { acquireRefreshFileLock } from '../../src/fs/index.ts'
import { lifetimeHooks } from '../fixtures/lifetime-hooks.js'
import { observed } from '../fixtures/observed.js'

const hooks = lifetimeHooks()
const { afterEach, test } = hooks

const CLAUSTRUM_OPENCODE_ENROLLMENT_NAME = enrollmentName(
  'test-auth',
  'opencode',
)
const CLAUSTRUM_PI_ENROLLMENT_NAME = enrollmentName('test-auth', 'pi')

const tempDirs: string[] = []
const secret = '01'.repeat(32)

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'claustrum-enrollment-'))
  tempDirs.push(dir)
  return getClaustrumEnrollmentPaths(join(dir, 'opencode-enrollment.json'))
}

function client(
  overrides: Partial<ClaustrumEnrollmentClient> = {},
): ClaustrumEnrollmentClient {
  return {
    enrollPropose: async () => ({ requestId: 'request-1' }),
    enrollPoll: async () => ({ status: 'pending' }),
    ...overrides,
  }
}

function manager(
  paths: Awaited<ReturnType<typeof fixture>>,
  enrollmentClient: ClaustrumEnrollmentClient,
  extra: Partial<
    ConstructorParameters<typeof ClaustrumEnrollmentManager>[0]
  > = {},
) {
  return hooks.lifetime.manage(
    new ClaustrumEnrollmentManager({
      client: enrollmentClient,
      paths,
      proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
      mintSecret: () => secret,
      now: () => 1_000,
      ...extra,
    }),
  )
}

async function seedPendingRequest(
  paths: Awaited<ReturnType<typeof fixture>>,
  requestId?: string,
) {
  await writeFile(
    paths.statePath,
    `${JSON.stringify({
      version: 1,
      phase: 'pending',
      proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
      requestSecret: secret,
      ...(requestId === undefined ? {} : { requestId }),
      createdAt: 1,
      updatedAt: 1,
    })}\n`,
    { mode: 0o600 },
  )
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

describe('enrollmentAuthority', () => {
  test('uses vault authority when a valid token file exists', async () => {
    const paths = await fixture()
    await writeFile(
      paths.tokenPath,
      JSON.stringify({ token: secret, token_generation: 1 }),
      { mode: 0o600 },
    )

    expect(
      await enrollmentAuthority(paths, CLAUSTRUM_OPENCODE_ENROLLMENT_NAME),
    ).toBe('vault')
  })

  test('uses vault authority for approved state when the token is missing', async () => {
    const paths = await fixture()
    await writeFile(
      paths.statePath,
      JSON.stringify({
        version: 1,
        phase: 'approved',
        proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
        tokenGeneration: 1,
        updatedAt: 1,
      }),
      { mode: 0o600 },
    )

    expect(
      await enrollmentAuthority(paths, CLAUSTRUM_OPENCODE_ENROLLMENT_NAME),
    ).toBe('vault')
  })

  test('uses vault authority for approved state when the token is corrupt', async () => {
    const paths = await fixture()
    await writeFile(
      paths.statePath,
      JSON.stringify({
        version: 1,
        phase: 'approved',
        proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
        tokenGeneration: 1,
        updatedAt: 1,
      }),
      { mode: 0o600 },
    )
    await writeFile(
      paths.tokenPath,
      JSON.stringify({ token: 'broken', token_generation: 1 }),
      { mode: 0o600 },
    )

    expect(
      await enrollmentAuthority(paths, CLAUSTRUM_OPENCODE_ENROLLMENT_NAME),
    ).toBe('vault')
  })

  test('uses local authority when no enrollment files exist', async () => {
    const paths = await fixture()

    expect(
      await enrollmentAuthority(paths, CLAUSTRUM_OPENCODE_ENROLLMENT_NAME),
    ).toBe('local')
  })

  test('uses local authority for pending, denied and blocked state', async () => {
    for (const state of [
      {
        version: 1,
        phase: 'pending',
        proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
        requestSecret: secret,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        version: 1,
        phase: 'denied',
        proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
        updatedAt: 1,
      },
      {
        version: 1,
        phase: 'blocked',
        proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
        errorCode: 'invalid_params',
        updatedAt: 1,
      },
    ]) {
      const paths = await fixture()
      await writeFile(paths.statePath, JSON.stringify(state), { mode: 0o600 })

      expect(
        await enrollmentAuthority(paths, CLAUSTRUM_OPENCODE_ENROLLMENT_NAME),
      ).toBe('local')
    }
  })

  test('treats a corrupt state file without a token as unreadable', async () => {
    const paths = await fixture()
    await writeFile(paths.statePath, '{broken', { mode: 0o600 })

    expect(
      await enrollmentAuthority(paths, CLAUSTRUM_OPENCODE_ENROLLMENT_NAME),
    ).toBe('unreadable')
  })

  test('treats state for another consumer name as unreadable', async () => {
    const paths = await fixture()
    await seedPendingRequest(paths)

    expect(await enrollmentAuthority(paths, CLAUSTRUM_PI_ENROLLMENT_NAME)).toBe(
      'unreadable',
    )
  })

  test('does not change directory entries or mtimes', async () => {
    const paths = await fixture()
    await writeFile(
      paths.statePath,
      JSON.stringify({
        version: 1,
        phase: 'approved',
        proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
        tokenGeneration: 1,
        updatedAt: 1,
      }),
      { mode: 0o600 },
    )
    await writeFile(
      paths.tokenPath,
      JSON.stringify({ token: secret, token_generation: 1 }),
      { mode: 0o600 },
    )
    const directory = dirname(paths.statePath)
    const filesBefore = await readdir(directory)
    const mtimesBefore = await Promise.all(
      [directory, paths.statePath, paths.tokenPath].map(
        async (path) => (await stat(path)).mtimeMs,
      ),
    )

    expect(
      await enrollmentAuthority(paths, CLAUSTRUM_OPENCODE_ENROLLMENT_NAME),
    ).toBe('vault')
    expect(await readdir(directory)).toEqual(filesBefore)
    expect(
      await Promise.all(
        [directory, paths.statePath, paths.tokenPath].map(
          async (path) => (await stat(path)).mtimeMs,
        ),
      ),
    ).toEqual(mtimesBefore)
  })
})

/** An approved ceremony with its token on disk, as a completed Connect leaves it. */
async function seedApproved(
  paths: Awaited<ReturnType<typeof fixture>>,
  proposedName = CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
) {
  await writeFile(
    paths.statePath,
    JSON.stringify({
      version: 1,
      phase: 'approved',
      proposedName,
      tokenGeneration: 1,
      updatedAt: 1,
    }),
    { mode: 0o600 },
  )
  await writeFile(
    paths.tokenPath,
    JSON.stringify({ token: secret, token_generation: 1 }),
    { mode: 0o600 },
  )
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

describe('disconnectClaustrumEnrollment', () => {
  test('removes the token and the state so enrollmentAuthority reports local', async () => {
    const paths = await fixture()
    await seedApproved(paths)
    expect(
      await enrollmentAuthority(paths, CLAUSTRUM_OPENCODE_ENROLLMENT_NAME),
    ).toBe('vault')

    expect(
      await disconnectClaustrumEnrollment(
        paths,
        CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
      ),
    ).toBe('disconnected')

    expect(
      await enrollmentAuthority(paths, CLAUSTRUM_OPENCODE_ENROLLMENT_NAME),
    ).toBe('local')
    expect(await exists(paths.tokenPath)).toBe(false)
    expect(await exists(paths.statePath)).toBe(false)
  })

  test('returns idle when neither file exists', async () => {
    const paths = await fixture()

    expect(
      await disconnectClaustrumEnrollment(
        paths,
        CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
      ),
    ).toBe('idle')
  })

  test('a crash after the token deletion stays vault and a repeat call reaches local', async () => {
    const paths = await fixture()
    await seedApproved(paths)
    // What a crash between the two deletions leaves: the token gone, the
    // approved state still there.
    await rm(paths.tokenPath)
    expect(
      await enrollmentAuthority(paths, CLAUSTRUM_OPENCODE_ENROLLMENT_NAME),
    ).toBe('vault')

    expect(
      await disconnectClaustrumEnrollment(
        paths,
        CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
      ),
    ).toBe('disconnected')
    expect(
      await enrollmentAuthority(paths, CLAUSTRUM_OPENCODE_ENROLLMENT_NAME),
    ).toBe('local')
  })

  test('keeps the state when the token cannot be removed', async () => {
    const paths = await fixture()
    await seedApproved(paths)
    // A non-empty directory at the token path makes its deletion fail, which
    // stands in for a crash before the token is gone.
    await rm(paths.tokenPath)
    await mkdir(paths.tokenPath)
    await writeFile(join(paths.tokenPath, 'keep'), 'x')
    const stateBefore = await readFile(paths.statePath, 'utf8')

    await expect(
      disconnectClaustrumEnrollment(paths, CLAUSTRUM_OPENCODE_ENROLLMENT_NAME),
    ).rejects.toThrow()

    expect(await readFile(paths.statePath, 'utf8')).toBe(stateBefore)
  })

  test('refuses state for another consumer and leaves both files unchanged', async () => {
    const paths = await fixture()
    await seedApproved(paths, CLAUSTRUM_PI_ENROLLMENT_NAME)
    const stateBefore = await readFile(paths.statePath, 'utf8')
    const tokenBefore = await readFile(paths.tokenPath, 'utf8')

    await expect(
      disconnectClaustrumEnrollment(paths, CLAUSTRUM_OPENCODE_ENROLLMENT_NAME),
    ).rejects.toThrow('different consumer')

    expect(await readFile(paths.statePath, 'utf8')).toBe(stateBefore)
    expect(await readFile(paths.tokenPath, 'utf8')).toBe(tokenBefore)
  })

  test('returns busy while the ceremony lock is held and deletes nothing', async () => {
    const paths = await fixture()
    await seedApproved(paths)
    const stateBefore = await readFile(paths.statePath, 'utf8')
    const tokenBefore = await readFile(paths.tokenPath, 'utf8')
    const held = await acquireRefreshFileLock({
      name: 'ceremony',
      path: paths.statePath,
      ttlMs: 30_000,
    })
    if (!held) throw new Error('fixture could not take the ceremony lock')
    try {
      expect(
        await disconnectClaustrumEnrollment(
          paths,
          CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
        ),
      ).toBe('busy')
    } finally {
      await held.release()
    }

    expect(await readFile(paths.statePath, 'utf8')).toBe(stateBefore)
    expect(await readFile(paths.tokenPath, 'utf8')).toBe(tokenBefore)
  })

  test('removes only the token and state files from their directory', async () => {
    const paths = await fixture()
    await seedApproved(paths)
    const directory = dirname(paths.statePath)
    const others = [
      'accounts.json',
      'opencode-enrollment.json.bak',
      'pi-enrollment.json',
      'pi-enrollment-state.json',
    ]
    for (const name of others)
      await writeFile(join(directory, name), name, { mode: 0o600 })
    await mkdir(join(directory, 'nested'))

    expect(
      await disconnectClaustrumEnrollment(
        paths,
        CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
      ),
    ).toBe('disconnected')

    expect((await readdir(directory)).sort()).toEqual(
      [...others, 'nested'].sort(),
    )
    for (const name of others)
      expect(await readFile(join(directory, name), 'utf8')).toBe(name)
  })
})

describe('ClaustrumEnrollmentManager', () => {
  test('persists the raw secret before proposing and hashes the decoded bytes', async () => {
    const paths = await fixture()
    const calls: string[] = []
    const instance = manager(
      paths,
      client({
        enrollPropose: async ({ name, requestSecretHash }) => {
          calls.push('propose')
          const persisted = JSON.parse(await readFile(paths.statePath, 'utf8'))
          expect(persisted.phase).toBe('pending')
          expect(persisted.requestSecret).toBe(secret)
          expect(persisted.requestId).toBeUndefined()
          expect(name).toBe(CLAUSTRUM_OPENCODE_ENROLLMENT_NAME)
          expect(requestSecretHash).toBe(
            createHash('sha256')
              .update(Buffer.from(secret, 'hex'))
              .digest('hex'),
          )
          return { requestId: 'request-1' }
        },
        enrollPoll: async ({ requestId, requestSecret }) => {
          calls.push('poll')
          expect(requestId).toBe('request-1')
          expect(requestSecret).toBe(secret)
          return {
            status: 'approved',
            name: 'renamed-consumer',
            token: 'ab'.repeat(32),
            tokenGeneration: 1,
          }
        },
      }),
    )

    await expect(instance.reconcile()).resolves.toEqual({
      state: 'approved',
      proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
      approvedName: 'renamed-consumer',
      tokenGeneration: 1,
    })
    expect(calls).toEqual(['propose', 'poll'])
    expect(JSON.parse(await readFile(paths.tokenPath, 'utf8'))).toEqual({
      token: 'ab'.repeat(32),
      token_generation: 1,
    })
    const finalState = await readFile(paths.statePath, 'utf8')
    expect(finalState).not.toContain(secret)
    expect(JSON.parse(finalState)).toMatchObject({
      phase: 'approved',
      approvedName: 'renamed-consumer',
      tokenGeneration: 1,
    })
    expect((await stat(paths.tokenPath)).mode & 0o777).toBe(0o600)
    expect((await stat(paths.statePath)).mode & 0o777).toBe(0o600)
  })

  test('re-proposes with the same persisted secret after a crash before the request id is saved', async () => {
    const paths = await fixture()
    const hashes: string[] = []
    const first = manager(
      paths,
      client({
        enrollPropose: async ({ requestSecretHash }) => {
          hashes.push(requestSecretHash)
          throw new Error('connection reset after server commit')
        },
      }),
    )
    await expect(first.reconcile()).rejects.toThrow(
      'connection reset after server commit',
    )

    const second = manager(
      paths,
      client({
        enrollPropose: async ({ requestSecretHash }) => {
          hashes.push(requestSecretHash)
          return { requestId: 'same-server-request' }
        },
      }),
    )
    await expect(second.reconcile()).resolves.toEqual({
      state: 'pending',
      proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
      requestId: 'same-server-request',
    })
    expect(hashes).toHaveLength(2)
    expect(hashes[0]).toBe(hashes[1])
    const persisted = JSON.parse(await readFile(paths.statePath, 'utf8'))
    expect(persisted.requestSecret).toBe(secret)
    expect(persisted.requestId).toBe('same-server-request')
  })

  test('keeps the secret and reports retryable queue saturation without inventing a request id', async () => {
    const paths = await fixture()
    const instance = manager(
      paths,
      client({
        enrollPropose: async () => {
          throw new ClaustrumCredentialError(
            'pending_queue_full',
            'transient',
            'retry',
          )
        },
      }),
    )
    await expect(instance.reconcile()).resolves.toEqual({
      state: 'pending',
      proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
      retryCode: 'pending_queue_full',
    })
    const persisted = JSON.parse(await readFile(paths.statePath, 'utf8'))
    expect(persisted.requestSecret).toBe(secret)
    expect(persisted.requestId).toBeUndefined()
  })

  test('blocks and scrubs the secret when another live proposal owns the name', async () => {
    const paths = await fixture()
    const instance = manager(
      paths,
      client({
        enrollPropose: async () => {
          throw new ClaustrumCredentialError(
            'pending_exists',
            'permanent',
            'gone',
          )
        },
      }),
    )
    await expect(instance.reconcile()).resolves.toEqual({
      state: 'blocked',
      proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
      code: 'pending_exists',
    })
    expect(await readFile(paths.statePath, 'utf8')).not.toContain(secret)
  })

  test('fails terminally and scrubs the secret for permanent ceremony refusals', async () => {
    for (const code of ['invalid_params', 'already_consumed', 'superseded']) {
      const paths = await fixture()
      const proposalFailure = code === 'invalid_params'
      const instance = manager(
        paths,
        client({
          ...(proposalFailure && {
            enrollPropose: async () => {
              throw new ClaustrumCredentialError(code, 'permanent', 'gone')
            },
          }),
          ...(!proposalFailure && {
            enrollPoll: async () => {
              throw new ClaustrumCredentialError(code, 'permanent', 'gone')
            },
          }),
        }),
      )
      await expect(instance.reconcile()).resolves.toEqual({
        state: 'blocked',
        proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
        code,
      })
      expect(await readFile(paths.statePath, 'utf8')).not.toContain(secret)
    }
  })

  test('removes the request secret when the operator denies enrollment', async () => {
    const paths = await fixture()
    const instance = manager(
      paths,
      client({ enrollPoll: async () => ({ status: 'denied' }) }),
    )
    await expect(instance.reconcile()).resolves.toEqual({
      state: 'denied',
      proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
    })
    const persisted = await readFile(paths.statePath, 'utf8')
    expect(persisted).not.toContain(secret)
    expect(JSON.parse(persisted).phase).toBe('denied')
  })

  test('resets only terminal local ceremony state', async () => {
    const deniedPaths = await fixture()
    const denied = manager(
      deniedPaths,
      client({ enrollPoll: async () => ({ status: 'denied' }) }),
    )
    await denied.reconcile()
    await expect(denied.resetTerminal()).resolves.toBe('reset')
    await expect(denied.status()).resolves.toEqual({ state: 'idle' })

    const pendingPaths = await fixture()
    const pending = manager(pendingPaths, client())
    await pending.reconcile()
    await expect(pending.resetTerminal()).resolves.toBe('refused-pending')

    const approvedPaths = await fixture()
    await writeEnrollmentTokenFile(approvedPaths.tokenPath, {
      token: 'ff'.repeat(32),
      token_generation: 1,
    })
    const approved = manager(approvedPaths, client())
    await expect(approved.resetTerminal()).resolves.toBe('refused-approved')
  })

  test('writes the one-shot token before replacing pending metadata', async () => {
    const paths = await fixture()
    let observedPending = false
    const instance = manager(
      paths,
      client({
        enrollPoll: async () => ({
          status: 'approved',
          name: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
          token: 'cd'.repeat(32),
          tokenGeneration: 2,
        }),
      }),
      {
        writeTokenFile: async (path, value) => {
          const state = JSON.parse(await readFile(paths.statePath, 'utf8'))
          observedPending =
            state.phase === 'pending' && state.requestSecret === secret
          await writeEnrollmentTokenFile(path, value)
        },
      },
    )
    await instance.reconcile()
    expect(observedPending).toBe(true)
  })

  test('an existing token suppresses all wire calls and scrubs interrupted pending state', async () => {
    const paths = await fixture()
    await writeEnrollmentTokenFile(paths.tokenPath, {
      token: 'ef'.repeat(32),
      token_generation: 3,
    })
    await writeFile(
      paths.statePath,
      `${JSON.stringify({
        version: 1,
        phase: 'pending',
        proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
        requestSecret: secret,
        requestId: 'request-before-crash',
        createdAt: 1,
        updatedAt: 1,
      })}\n`,
      { mode: 0o600 },
    )
    let calls = 0
    const instance = manager(
      paths,
      client({
        enrollPropose: async () => {
          calls += 1
          return { requestId: 'unexpected' }
        },
        enrollPoll: async () => {
          calls += 1
          return { status: 'pending' }
        },
      }),
    )
    await expect(instance.reconcile()).resolves.toEqual({
      state: 'approved',
      proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
      tokenGeneration: 3,
    })
    expect(calls).toBe(0)
    expect(await readFile(paths.statePath, 'utf8')).not.toContain(secret)
  })

  test('fails closed on an owner-readable enrollment file with group permissions', async () => {
    const paths = await fixture()
    await writeFile(paths.statePath, '{}\n', { mode: 0o640 })
    await chmod(paths.statePath, 0o640)
    let calls = 0
    const instance = manager(
      paths,
      client({
        enrollPropose: async () => {
          calls += 1
          return { requestId: 'unexpected' }
        },
      }),
    )
    await expect(instance.reconcile()).rejects.toThrow('owner-only')
    expect(calls).toBe(0)
  })

  // open(..., 0o600) is masked by the umask, so only the chmod before the
  // rename keeps the request secret's file owner read-write. A umask that
  // strips the owner's write bit shows whether that chmod ran.
  test('persists the enrollment state 0600 despite a umask that strips owner write', async () => {
    const paths = await fixture()
    let proposedMode: number | undefined
    const instance = manager(
      paths,
      client({
        enrollPropose: async () => {
          proposedMode = (await stat(paths.statePath)).mode & 0o777
          return { requestId: 'request-1' }
        },
      }),
    )
    const previous = process.umask(0o277)
    try {
      await instance.reconcile()
    } finally {
      process.umask(previous)
    }
    expect(proposedMode).toBe(0o600)
    expect((await stat(paths.statePath)).mode & 0o777).toBe(0o600)
  })

  test('refuses to persist a request secret below an unsafe writable ancestor', async () => {
    const paths = await fixture()
    const unsafe = join(dirname(paths.tokenPath), 'unsafe')
    await mkdir(unsafe)
    await chmod(unsafe, 0o777)
    const unsafePaths = getClaustrumEnrollmentPaths(
      join(unsafe, 'private', 'enrollment.json'),
    )
    let proposed = false
    const instance = manager(
      unsafePaths,
      client({
        enrollPropose: async () => {
          proposed = true
          return { requestId: 'unexpected' }
        },
      }),
    )
    await expect(instance.reconcile()).rejects.toThrow('writable ancestor:')
    expect(proposed).toBe(false)
  })

  test('refuses a symlinked enrollment state before any wire call', async () => {
    const paths = await fixture()
    const target = join(dirname(paths.statePath), 'attacker-state.json')
    await writeFile(target, '{}\n', { mode: 0o600 })
    await symlink(target, paths.statePath)
    let calls = 0
    const instance = manager(
      paths,
      client({
        enrollPropose: async () => {
          calls += 1
          return { requestId: 'unexpected' }
        },
      }),
    )
    await expect(instance.reconcile()).rejects.toThrow(
      'could not be opened safely',
    )
    expect(calls).toBe(0)
  })

  test('serializes concurrent process instances so only one proposal is sent', async () => {
    const paths = await fixture()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    hooks.lifetime.unpark(() => release())
    let proposals = 0
    const proposed = Promise.withResolvers<void>()
    const first = manager(
      paths,
      client({
        enrollPropose: async () => {
          proposals += 1
          proposed.resolve()
          await gate
          return { requestId: 'request-1' }
        },
      }),
    )
    const second = manager(paths, client())
    const firstRun = first.reconcile()
    await observed(hooks.lifetime, proposed.promise)
    await expect(second.reconcile()).resolves.toEqual({ state: 'busy' })
    release()
    await firstRun
    expect(proposals).toBe(1)
  })

  test('treats poll not_found as permanent without probing through re-proposal', async () => {
    const paths = await fixture()
    let proposals = 0
    let polls = 0
    const instance = manager(
      paths,
      client({
        enrollPropose: async () => ({ requestId: `request-${++proposals}` }),
        enrollPoll: async () => {
          polls += 1
          throw new ClaustrumCredentialError('not_found', 'permanent', 'gone')
        },
      }),
    )
    const blocked = {
      state: 'blocked' as const,
      proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
      code: 'not_found',
    }
    await expect(instance.reconcile()).resolves.toEqual(blocked)
    await expect(instance.reconcile()).resolves.toEqual(blocked)
    expect(proposals).toBe(1)
    expect(polls).toBe(1)
  })

  test('persists every permanent poll refusal as an operator-visible terminal state', async () => {
    for (const code of ['already_consumed', 'superseded', 'invalid_params']) {
      const paths = await fixture()
      const instance = manager(
        paths,
        client({
          enrollPoll: async () => {
            throw new ClaustrumCredentialError(code, 'permanent', 'gone')
          },
        }),
      )
      await expect(instance.reconcile()).resolves.toEqual({
        state: 'blocked',
        proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
        code,
      })
      await expect(
        readClaustrumEnrollmentStatus(
          paths,
          CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
        ),
      ).resolves.toEqual({
        state: 'blocked',
        proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
        code,
      })
    }
  })

  test('blocks a retryable poll refusal whose code is protocol-terminal and stops re-polling', async () => {
    for (const code of [
      'invalid_params',
      'pending_exists',
      'not_found',
      'already_consumed',
      'superseded',
      'stale_generation',
    ]) {
      const paths = await fixture()
      await seedPendingRequest(paths, 'request-1')
      let polls = 0
      const instance = manager(
        paths,
        client({
          enrollPoll: async () => {
            polls += 1
            throw new ClaustrumCredentialError(code, 'transient', 'retry')
          },
        }),
      )
      const blocked = {
        state: 'blocked' as const,
        proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
        code,
      }
      await expect(instance.reconcile()).resolves.toEqual(blocked)
      expect(JSON.parse(await readFile(paths.statePath, 'utf8')).phase).toBe(
        'blocked',
      )
      await expect(instance.reconcile()).resolves.toEqual(blocked)
      expect(polls).toBe(1)
    }
  })

  test('blocks a retryable propose refusal whose code is protocol-terminal', async () => {
    for (const code of [
      'invalid_params',
      'pending_exists',
      'not_found',
      'already_consumed',
      'superseded',
      'stale_generation',
    ]) {
      const paths = await fixture()
      await seedPendingRequest(paths)
      const instance = manager(
        paths,
        client({
          enrollPropose: async () => {
            throw new ClaustrumCredentialError(code, 'transient', 'retry')
          },
        }),
      )
      await expect(instance.reconcile()).resolves.toEqual({
        state: 'blocked',
        proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
        code,
      })
      expect(JSON.parse(await readFile(paths.statePath, 'utf8')).phase).toBe(
        'blocked',
      )
    }
  })

  test('keeps genuinely retryable poll refusals pending', async () => {
    for (const code of [
      'pending_queue_full',
      'store_error',
      'transport_error',
    ]) {
      const paths = await fixture()
      await seedPendingRequest(paths, 'request-1')
      const instance = manager(
        paths,
        client({
          enrollPoll: async () => {
            throw new ClaustrumCredentialError(code, 'transient', 'retry')
          },
        }),
      )
      await expect(instance.reconcile()).resolves.toEqual({
        state: 'pending',
        proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
        requestId: 'request-1',
        retryCode: code,
      })
      expect(JSON.parse(await readFile(paths.statePath, 'utf8')).phase).toBe(
        'pending',
      )
    }
  })

  test('blocks approved metadata when the authoritative token file is missing', async () => {
    const paths = await fixture()
    await writeFile(
      paths.statePath,
      `${JSON.stringify({
        version: 1,
        phase: 'approved',
        proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
        approvedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
        tokenGeneration: 2,
        updatedAt: Date.now(),
      })}\n`,
      { mode: 0o600 },
    )
    const instance = manager(paths, client())
    await expect(instance.reconcile()).resolves.toEqual({
      state: 'blocked',
      proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
      code: 'missing_token',
    })
  })

  test('reads a persisted approved status without exposing the enrollment token', async () => {
    const paths = await fixture()
    const token = 'aa'.repeat(32)
    await writeEnrollmentTokenFile(paths.tokenPath, {
      token,
      token_generation: 4,
    })
    const status = await readClaustrumEnrollmentStatus(
      paths,
      CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
    )
    expect(status).toEqual({
      state: 'approved',
      proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
      tokenGeneration: 4,
    })
    expect(JSON.stringify(status)).not.toContain(token)
  })
})

describe('scoped enrollment token reads', () => {
  test('reads each atomic replacement rather than retaining the previous token', async () => {
    const paths = await fixture()
    await writeEnrollmentTokenFile(paths.tokenPath, {
      token: secret,
      token_generation: 1,
    })
    expect(await readClaustrumEnrollmentToken(paths.tokenPath)).toEqual({
      token: secret,
      token_generation: 1,
    })
    await writeEnrollmentTokenFile(paths.tokenPath, {
      token: '02'.repeat(32),
      token_generation: 2,
    })
    expect(await readClaustrumEnrollmentToken(paths.tokenPath)).toEqual({
      token: '02'.repeat(32),
      token_generation: 2,
    })
    await rm(paths.tokenPath)
    await expect(readClaustrumEnrollmentToken(paths.tokenPath)).rejects.toThrow(
      'not configured',
    )
  })

  test.skipIf(process.platform === 'win32')(
    'refuses symlinks and world-readable token files',
    async () => {
      const paths = await fixture()
      await writeEnrollmentTokenFile(paths.tokenPath, {
        token: secret,
        token_generation: 1,
      })
      const link = join(dirname(paths.tokenPath), 'link.json')
      await symlink(paths.tokenPath, link)
      await expect(readClaustrumEnrollmentToken(link)).rejects.toThrow()
      await chmod(paths.tokenPath, 0o644)
      await expect(
        readClaustrumEnrollmentToken(paths.tokenPath),
      ).rejects.toThrow('owner-only')
    },
  )
})

test('a second host cannot adopt or reset another host ceremony on disk', async () => {
  const paths = await fixture()
  const original = manager(
    paths,
    client({ enrollPoll: async () => ({ status: 'denied' }) }),
  )
  await original.reconcile()
  const before = await readFile(paths.statePath, 'utf8')
  let calls = 0
  const other = manager(
    paths,
    client({
      enrollPropose: async () => {
        calls++
        return { requestId: 'wrong-host' }
      },
    }),
    { proposedName: CLAUSTRUM_PI_ENROLLMENT_NAME },
  )
  await expect(other.reconcile()).rejects.toThrow('different consumer')
  await expect(other.resetTerminal()).rejects.toThrow('different consumer')
  expect(await readFile(paths.statePath, 'utf8')).toBe(before)
  expect(calls).toBe(0)
})

test('Pi token-only status uses its own consumer name', async () => {
  const paths = await fixture()
  await writeEnrollmentTokenFile(paths.tokenPath, {
    token: secret,
    token_generation: 1,
  })
  const instance = manager(paths, client(), {
    proposedName: CLAUSTRUM_PI_ENROLLMENT_NAME,
  })
  expect(await instance.status()).toEqual({
    state: 'approved',
    proposedName: CLAUSTRUM_PI_ENROLLMENT_NAME,
    tokenGeneration: 1,
  })
  expect(
    await readClaustrumEnrollmentStatus(paths, CLAUSTRUM_PI_ENROLLMENT_NAME),
  ).toEqual(await instance.status())
})

test('a terminal refusal committed by one process stops an older process on its next tick', async () => {
  const paths = await fixture()
  await seedPendingRequest(paths, 'expired-request')
  let oldProcessPolls = 0
  const oldProcess = manager(
    paths,
    client({
      enrollPoll: async () => {
        oldProcessPolls++
        return { status: 'pending' }
      },
    }),
  )
  const newProcess = manager(
    paths,
    client({
      enrollPoll: async () => {
        throw new ClaustrumCredentialError('superseded', 'transient', 'retry')
      },
    }),
  )
  expect(await oldProcess.reconcile()).toMatchObject({ state: 'pending' })
  expect(oldProcessPolls).toBe(1)
  expect(await newProcess.reconcile()).toEqual({
    state: 'blocked',
    proposedName: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
    code: 'superseded',
  })
  expect(await oldProcess.reconcile()).toMatchObject({
    state: 'blocked',
    code: 'superseded',
  })
  expect(oldProcessPolls).toBe(1)
  expect(
    JSON.parse(await readFile(paths.statePath, 'utf8')),
  ).not.toHaveProperty('requestSecret')
})

test('OpenCode and Pi resolve separate owner-only enrollment paths from the same state root', () => {
  const stateDir = join(tmpdir(), 'shared-state', 'cortexkit', 'test-auth')
  const opencode = hostEnrollmentPaths({ stateDir, host: 'opencode' })
  const pi = hostEnrollmentPaths({ stateDir, host: 'pi' })
  expect(opencode).toEqual({
    tokenPath: join(stateDir, 'opencode-enrollment.json'),
    statePath: join(stateDir, 'opencode-enrollment-state.json'),
  })
  expect(pi).toEqual({
    tokenPath: join(stateDir, 'pi-enrollment.json'),
    statePath: join(stateDir, 'pi-enrollment-state.json'),
  })
  expect(pi.tokenPath).not.toBe(opencode.tokenPath)
  expect(CLAUSTRUM_OPENCODE_ENROLLMENT_NAME).toBe('test-auth-opencode')
  expect(CLAUSTRUM_PI_ENROLLMENT_NAME).toBe('test-auth-pi')
})

test('host-specific overrides resolve absolute and project-relative enrollment paths without crossing hosts', () => {
  const project = join(tmpdir(), 'enrollment-project')
  const stateDir = join(project, 'state')
  const piToken = join(project, 'owner', 'pi.json')
  expect(
    hostEnrollmentPaths({ stateDir, host: 'pi', override: piToken }),
  ).toEqual({
    tokenPath: piToken,
    statePath: join(project, 'owner', 'pi-state.json'),
  })
  expect(
    hostEnrollmentPaths({
      stateDir,
      host: 'opencode',
      override: 'owner/opencode.json',
      cwd: project,
    }),
  ).toEqual({
    tokenPath: join(project, 'owner', 'opencode.json'),
    statePath: join(project, 'owner', 'opencode-state.json'),
  })
  expect(() =>
    hostEnrollmentPaths({ stateDir, host: 'pi', override: 'relative.json' }),
  ).toThrow('base directory')
})

test('classifies enrollment refusals as (code, disposition) with the producer code winning', () => {
  const cases: Array<
    [string, 'transient' | 'permanent', 'retry' | 'gone', string]
  > = [
    ['pending_exists', 'transient', 'retry', 'terminal'],
    ['invalid_params', 'transient', 'retry', 'terminal'],
    ['not_found', 'transient', 'retry', 'terminal'],
    ['already_consumed', 'transient', 'retry', 'terminal'],
    ['superseded', 'transient', 'retry', 'terminal'],
    ['stale_generation', 'transient', 'retry', 'terminal'],
    ['pending_queue_full', 'permanent', 'gone', 'retry'],
    ['transport_error', 'transient', 'retry', 'retry'],
    ['something_new', 'permanent', 'gone', 'terminal'],
  ]
  for (const [code, errorClass, action, disposition] of cases) {
    expect(
      classifyEnrollmentError(
        new ClaustrumCredentialError(code, errorClass, action),
      ),
    ).toEqual({ code, disposition: disposition as 'terminal' | 'retry' })
  }
  expect(classifyEnrollmentError(new Error('socket closed'))).toBeUndefined()
})

test.skipIf(process.platform === 'win32')(
  'keeps the token owner-only in an owner-only directory, tightening a group-readable one',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'claustrum-enrollment-'))
    tempDirs.push(root)
    const created = getClaustrumEnrollmentPaths(
      join(root, 'fresh', 'opencode-enrollment.json'),
    )
    const loose = join(root, 'loose')
    await mkdir(loose, { mode: 0o755 })
    await chmod(loose, 0o755)
    const existing = getClaustrumEnrollmentPaths(
      join(loose, 'opencode-enrollment.json'),
    )
    for (const paths of [created, existing]) {
      await manager(
        paths,
        client({
          enrollPoll: async () => ({
            status: 'approved',
            name: CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
            token: 'ab'.repeat(32),
            tokenGeneration: 1,
          }),
        }),
      ).reconcile()
      expect((await stat(dirname(paths.tokenPath))).mode & 0o777).toBe(0o700)
      expect((await stat(paths.tokenPath)).mode & 0o777).toBe(0o600)
      expect((await stat(paths.statePath)).mode & 0o777).toBe(0o600)
    }
  },
)
