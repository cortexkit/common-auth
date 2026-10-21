// @ts-check
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeEnrollmentTokenFile } from '@cortexkit/claustrum-client'
import { createOwnerOnly, verifySafeParent } from '@cortexkit/private-files'
import {
  ClaustrumConsumer,
  ClaustrumEnrollmentManager,
  connectClaustrumEnrollmentClient,
  connectClaustrumScopedClient,
  disconnectClaustrumEnrollment,
  drainVaultQuota,
  enrollmentAuthority,
  getClaustrumEnrollmentPaths,
  readVaultRoster,
} from '../../dist/claustrum/index.js'
import { startMockDaemon } from '../claustrum/mock-daemon.ts'
import { vaultTestNames } from './vault-summary.mjs'
import {
  ownChild,
  pending,
  timedOut,
  watchdogFailures,
  withWatchdog,
} from './watchdog.mjs'

const nodeTest = await import('node:test')
const test = process.versions.bun
  ? (await import('bun:test')).test
  : /** @param {string} name @param {() => Promise<void>} body */
    (name, body) => nodeTest.test(name, { timeout: 100_000 }, body)
const after = process.versions.bun
  ? (await import('bun:test')).afterAll
  : nodeTest.after

after(() => {
  // Native IO cannot be cancelled, so a failed watchdog must also end the process.
  if (watchdogFailures) setTimeout(() => process.exit(1), 1_000)
})

assert.equal(
  process.platform,
  'win32',
  'vault qualification requires real Windows',
)
assert.ok(
  process.env.LOCALAPPDATA,
  'a real per-user application-data folder is required',
)
assert.ok(process.env.SystemRoot)
const profile = resolve(homedir())
const profileRelative = relative(profile, process.env.LOCALAPPDATA)
assert.ok(
  profileRelative &&
    !isAbsolute(profileRelative) &&
    !profileRelative.startsWith('..'),
  `LOCALAPPDATA must be inside the runner user's real profile: ${profile}`,
)
const evidence = resolve(
  'windows-vault-evidence',
  `${process.versions.bun ? 'bun' : 'node'}-${process.versions.bun ?? process.version}-${process.arch}`,
)
await mkdir(evidence, { recursive: true })
const here = dirname(fileURLToPath(import.meta.url))
const powershell = join(
  process.env.SystemRoot,
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)

/** @param {Record<string, unknown>} request */
async function inspector(request) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key.toUpperCase() !== 'PSMODULEPATH',
    ),
  )
  const child = spawn(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(here, 'inspect.ps1'),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env },
  )
  ownChild(child)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (bytes) => {
    stdout += bytes
  })
  child.stderr.on('data', (bytes) => {
    stderr += bytes
  })
  child.stdin.end(JSON.stringify(request))
  return pending(
    `ACL inspector ${request.action}`,
    () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill()
          reject(new Error(`ACL inspector timed out: ${stderr}`))
        }, 30_000)
        child.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.once('close', (code) => {
          clearTimeout(timer)
          if (code !== 0)
            reject(
              new Error(`ACL inspector failed (${code}): ${stdout}\n${stderr}`),
            )
          else resolve(stdout.trim())
        })
      }),
  )
}

/** @param {string[]} paths @param {string} label */
async function inspectOwnerOnly(paths, label) {
  const result = JSON.parse(await inspector({ action: 'inspect', paths }))
  await writeFile(
    join(evidence, `${label}.json`),
    JSON.stringify(result, null, 2),
  )
  assert.equal(result.filesystem, 'NTFS')
  assert.equal(result.objects.length, paths.length)
  for (const object of result.objects) {
    assert.equal(object.owner, result.sid, `owner: ${object.path}`)
    assert.equal(
      object.control & 0x1004,
      0x1004,
      `protected present DACL: ${object.path}`,
    )
    assert.deepEqual(
      object.aces,
      [
        {
          type: 0,
          flags: object.directory ? 3 : 0,
          mask: 0x1f01ff,
          sid: result.sid,
        },
      ],
      `owner-only full control: ${object.path}`,
    )
  }
}

async function fixture() {
  const root = join(
    process.env.LOCALAPPDATA ?? '',
    `common-auth-vault-${randomUUID()}`,
  )
  await pending(`private profile folder ${root}`, () =>
    createOwnerOnly(root, { kind: 'dir' }),
  )
  const credentialId = 'oauth:test:windows'
  /** @type {import('../claustrum/mock-daemon.ts').MockCredential} */
  const record = {
    payload: JSON.stringify({ access_token: 'windows-served-access' }),
    account_id: 'windows-account',
    record_version: 41,
    expires_at_ms: Date.now() + 3_600_000,
  }
  const paths = getClaustrumEnrollmentPaths(
    join(root, 'state', 'enrollment.json'),
  )
  /** @type {import('../claustrum/mock-daemon.ts').MockDaemon | undefined} */
  let daemon
  /** @type {import('../../src/claustrum/index.ts').ClaustrumEnrollmentConnection | undefined} */
  let client
  try {
    daemon = await pending('mock daemon listen', () =>
      startMockDaemon({
        directory: root,
        credentials: { [credentialId]: record },
      }),
    )
    assert.ok(daemon)
    const connectionFile = daemon.connectionFile
    client = await pending('real enrollment client connect', () =>
      connectClaustrumEnrollmentClient({
        connectionFile,
        identity: {
          project_root: root,
          harness: 'windows-vault',
          session: randomUUID(),
        },
        logger: () => {},
      }),
    )
    assert.ok(client)
    const proposedName = 'common-auth-windows-vault'
    const manager = new ClaustrumEnrollmentManager({
      client,
      paths,
      proposedName,
    })
    return {
      root,
      daemon,
      client,
      paths,
      proposedName,
      manager,
      record,
      credentialId,
    }
  } catch (error) {
    client?.close()
    await daemon?.stop()
    if (!timedOut()) await rm(root, { recursive: true, force: true })
    throw error
  }
}

/** @param {Awaited<ReturnType<typeof fixture>>} s @param {string} label */
async function enroll(s, label) {
  assert.equal(await enrollmentAuthority(s.paths, s.proposedName), 'local')
  const pendingState = await pending('manager propose and poll', () =>
    s.manager.reconcile(),
  )
  assert.equal(pendingState.state, 'pending')
  assert.ok('requestId' in pendingState && pendingState.requestId)
  assert.equal(s.daemon.proposals.length, 1)
  assert.equal(s.daemon.proposals[0]?.name, s.proposedName)
  await inspectOwnerOnly([s.paths.statePath], `${label}-pending`)
  s.daemon.approve(pendingState.requestId, 'ab'.repeat(32), 1)
  const approved = await pending(
    'manager poll approval and publish token',
    () => s.manager.reconcile(),
  )
  assert.equal(approved.state, 'approved')
  assert.ok('tokenGeneration' in approved && approved.tokenGeneration === 1)
  assert.equal(s.daemon.polls, 2)
  assert.deepEqual(JSON.parse(await readFile(s.paths.tokenPath, 'utf8')), {
    token: 'ab'.repeat(32),
    token_generation: 1,
  })
  const state = JSON.parse(await readFile(s.paths.statePath, 'utf8'))
  assert.equal(state.phase, 'approved')
  assert.equal(state.tokenGeneration, 1)
  assert.equal('requestSecret' in state, false)
  assert.equal(await enrollmentAuthority(s.paths, s.proposedName), 'vault')
  assert.deepEqual(await verifySafeParent(dirname(s.paths.tokenPath)), {
    ok: true,
  })
  await inspectOwnerOnly(
    [dirname(s.paths.tokenPath), s.paths.tokenPath, s.paths.statePath],
    `${label}-approved`,
  )
}

/** @param {Awaited<ReturnType<typeof fixture>>} s */
async function disconnect(s) {
  assert.equal(
    await pending('disconnect enrollment', () =>
      disconnectClaustrumEnrollment(s.paths, s.proposedName),
    ),
    'disconnected',
  )
  for (const path of [s.paths.tokenPath, s.paths.statePath]) {
    await assert.rejects(access(path), { code: 'ENOENT' })
  }
  assert.equal(await enrollmentAuthority(s.paths, s.proposedName), 'local')
}

/** @param {(s: Awaited<ReturnType<typeof fixture>>) => Promise<void>} body */
async function scenario(body) {
  const s = await fixture()
  try {
    await body(s)
  } finally {
    s.client.close()
    await pending('mock daemon stop', () => s.daemon.stop())
    // A timed-out native write may still be using the folder; retain it for diagnosis.
    if (!timedOut())
      await pending('profile fixture cleanup', () =>
        rm(s.root, { recursive: true, force: true }),
      )
  }
}

test(vaultTestNames[0], () =>
  withWatchdog(vaultTestNames[0], 90_000, () =>
    scenario(async (s) => {
      await enroll(s, 'serving')
      /** @type {unknown[]} */
      const errors = []
      const consumer = new ClaustrumConsumer({
        rosterPath: join(s.root, 'state', 'vault-roster.json'),
        tokenPath: s.paths.tokenPath,
        family: { refreshAdapter: 'test-provider', category: 'test-native' },
        connect: () =>
          connectClaustrumScopedClient({
            connectionFile: s.daemon.connectionFile,
            identity: {
              project_root: s.root,
              harness: 'windows-vault',
              session: 'serving',
            },
            logger: () => {},
          }),
        isCustodyActive: async () =>
          (await enrollmentAuthority(s.paths, s.proposedName)) === 'vault',
        pollIntervalMs: 0,
        onError: (error) => {
          errors.push(error)
        },
      })
      try {
        const roster = await pending('consumer list_scoped', () =>
          consumer.refresh(),
        )
        assert.equal(s.daemon.lists, 1)
        assert.equal(roster?.rows.length, 1)
        const row = roster?.rows[0]
        assert.ok(row)
        assert.equal(row.credentialId, s.credentialId)
        assert.equal(row.accountIdentity, 'windows-account')
        assert.deepEqual(
          consumer.routingRows().map((route) => route.id),
          [row.routeId],
        )
        let sends = 0
        const response = await pending(
          'consumer send and served-401 report',
          () =>
            consumer.send(
              row.routeId,
              async (receipt) => {
                sends++
                assert.equal(receipt.accessToken, 'windows-served-access')
                assert.equal(receipt.recordVersion, 41)
                assert.deepEqual(s.daemon.gets, [
                  {
                    credential_id: s.credentialId,
                    enrollment_token: 'ab'.repeat(32),
                  },
                ])
                const resetsAt = new Date(Date.now() + 3_600_000).toISOString()
                const observation = {
                  checkedAt: Date.now(),
                  readings: [
                    {
                      label: '5h',
                      usedPercent: 25,
                      resetsAt,
                    },
                  ],
                }
                assert.equal(
                  await pending('record quota with served receipt', () =>
                    consumer.recordQuota(row.routeId, observation, receipt),
                  ),
                  true,
                )
                await pending('drain roster quota publication', () =>
                  drainVaultQuota(join(s.root, 'state', 'vault-roster.json')),
                )
                const persisted = await readVaultRoster(
                  join(s.root, 'state', 'vault-roster.json'),
                )
                assert.deepEqual(persisted?.rows[0]?.quota, {
                  limits: [
                    {
                      scope: 'all',
                      label: '5h',
                      kind: 'reading',
                      checkedAt: observation.checkedAt,
                      usedPercent: 25,
                      resetsAt,
                    },
                  ],
                })
                await inspectOwnerOnly(
                  [
                    s.paths.tokenPath,
                    s.paths.statePath,
                    join(s.root, 'state', 'vault-roster.json'),
                  ],
                  'serving-quota',
                )

                // The vault moves ahead before the send's 401 arrives, but refuses a
                // retry. The consumer must report the version used by this sole send.
                s.record.record_version = 42
                s.record.refuse = 'needs_reauth'
                await pending('refresh newer record version', () =>
                  consumer.refresh(),
                )
                assert.equal(s.daemon.lists, 2)
                return new Response(null, { status: 401 })
              },
              { site: 'model', reporterSource: 'direct' },
            ),
        )
        assert.equal(response.status, 401)
        assert.equal(sends, 1)
        assert.deepEqual(s.daemon.reports, [
          {
            credential_id: s.credentialId,
            enrollment_token: 'ab'.repeat(32),
            provider_status: 401,
            record_version: 41,
            reporter_source: 'direct',
          },
        ])
        assert.equal(s.daemon.gets.length, 2)
        await pending('settle post-report refresh', () => consumer.refresh())
        assert.deepEqual(errors, [])
        await disconnect(s)
      } finally {
        consumer.close()
      }
    }),
  ),
)

test(vaultTestNames[1], () =>
  withWatchdog(vaultTestNames[1], 90_000, () =>
    scenario(async (s) => {
      await enroll(s, 'rewrite')
      const before = await readFile(s.paths.tokenPath, 'utf8')
      // An approved manager deliberately does not re-enroll. Obtain a second
      // approval over the real client, then use its public writer on the same path.
      const secret = randomBytes(32)
      const second = await pending('second real enrollment proposal', () =>
        s.client.enrollPropose({
          name: s.proposedName,
          requestSecretHash: createHash('sha256').update(secret).digest('hex'),
        }),
      )
      s.daemon.approve(second.requestId, 'cd'.repeat(32), 2)
      const outcome = await pending(
        'second real enrollment approval poll',
        () =>
          s.client.enrollPoll({
            requestId: second.requestId,
            requestSecret: secret.toString('hex'),
          }),
      )
      assert.equal(outcome.status, 'approved')
      assert.ok(outcome.status === 'approved')
      assert.equal(outcome.tokenGeneration, 2)
      assert.equal(await readFile(s.paths.tokenPath, 'utf8'), before)
      await pending('client 0.9.0 rewrite of existing token', () =>
        writeEnrollmentTokenFile(s.paths.tokenPath, {
          token: outcome.token,
          token_generation: outcome.tokenGeneration,
        }),
      )
      assert.deepEqual(JSON.parse(await readFile(s.paths.tokenPath, 'utf8')), {
        token: 'cd'.repeat(32),
        token_generation: 2,
      })
      assert.equal(s.daemon.proposals.length, 2)
      assert.equal(s.daemon.polls, 3)
      await inspectOwnerOnly(
        [dirname(s.paths.tokenPath), s.paths.tokenPath, s.paths.statePath],
        'rewrite-replaced',
      )
      await disconnect(s)
    }),
  ),
)

test(vaultTestNames[2], () =>
  withWatchdog(vaultTestNames[2], 90_000, () =>
    scenario(async (s) => {
      // Read-only sharing passes safe-parent checks but still violates the client's
      // stricter owner-only rule for the completed token-writing folder.
      const shared = join(s.root, 'readable-token-folder')
      await pending('create readable parent fixture', () =>
        createOwnerOnly(shared, { kind: 'dir' }),
      )
      await inspector({ action: 'users-read', path: shared })
      assert.deepEqual(await verifySafeParent(shared), { ok: true })
      const sharedPath = join(shared, 'enrollment.json')
      await assert.rejects(
        pending('token writer non-private-folder refusal', () =>
          writeEnrollmentTokenFile(sharedPath, {
            token: 'ef'.repeat(32),
            token_generation: 1,
          }),
        ),
        (error) => {
          assert.ok(error instanceof Error)
          assert.match(
            error.message,
            /^enrollment token folder .* is not private:/,
          )
          assert.ok(
            error.message.includes(shared),
            `refusal must name the folder ${shared}: ${error.message}`,
          )
          console.log(
            JSON.stringify({
              event: 'token-parent-refusal',
              parent: shared,
              message: error.message,
            }),
          )
          return true
        },
      )
      await assert.rejects(access(sharedPath), { code: 'ENOENT' })
      const parent = join(s.root, 'unsafe-token-folder')
      await pending('create refusal fixture', () =>
        createOwnerOnly(parent, { kind: 'dir' }),
      )
      await inspector({ action: 'users-modify', path: parent })
      const result = await verifySafeParent(parent)
      assert.equal(result.ok, false)
      assert.ok(!result.ok)
      assert.equal(result.reason, 'writable-by-others')
      const path = join(parent, 'enrollment.json')
      await assert.rejects(
        pending('token writer unsafe-folder refusal', () =>
          writeEnrollmentTokenFile(path, {
            token: 'ef'.repeat(32),
            token_generation: 1,
          }),
        ),
        (error) => {
          assert.ok(error instanceof Error)
          assert.match(
            error.message,
            /^enrollment token folder .* is not private:/,
          )
          assert.ok(
            error.message.includes(parent),
            `refusal must name the folder ${parent}: ${error.message}`,
          )
          console.log(
            JSON.stringify({
              event: 'token-parent-refusal',
              parent,
              message: error.message,
            }),
          )
          return true
        },
      )
      await assert.rejects(access(path), { code: 'ENOENT' })
      const manager = new ClaustrumEnrollmentManager({
        client: s.client,
        paths: getClaustrumEnrollmentPaths(path),
        proposedName: s.proposedName,
      })
      await assert.rejects(
        pending('manager unsafe-folder refusal', () => manager.reconcile()),
        (error) => {
          assert.ok(error instanceof Error)
          assert.ok(
            error.message.includes(parent),
            `manager refusal must name ${parent}: ${error.message}`,
          )
          console.log(
            JSON.stringify({
              event: 'manager-parent-refusal',
              parent,
              message: error.message,
            }),
          )
          return true
        },
      )
      assert.equal(s.daemon.proposals.length, 0)
      await assert.rejects(
        access(getClaustrumEnrollmentPaths(path).statePath),
        { code: 'ENOENT' },
      )
    }),
  ),
)
