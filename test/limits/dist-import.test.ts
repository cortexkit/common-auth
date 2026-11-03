import { expect, test } from 'bun:test'
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountKey, PolicyFacts } from '@cortexkit/common-auth/limits'

const now = 1_700_000_000_000
const A: AccountKey = {
  namespace: 'dist-import',
  accountId: 'A',
  incarnation: '1',
}
const B: AccountKey = {
  namespace: 'dist-import',
  accountId: 'B',
  incarnation: '1',
}
const facts: Omit<PolicyFacts, 'history'> = {
  phase: 'after-limit',
  host: 'opencode1',
  now,
  clockNow: 1000,
  sessionId: 'dist-session',
  requestScope: { kind: 'model', model: 'claude-sonnet' },
  attempted: A,
  signal: {
    account: A,
    kind: 'rate-limit',
    reason: 'rate',
    status: 429,
    scope: { kind: 'model', model: 'claude-sonnet' },
    windows: [],
    observedAt: now,
  },
  delivery: { owned: true, attributable: true, replayable: true },
  candidates: [
    {
      account: A,
      admitted: true,
      placementEligible: true,
      ready: false,
      blockers: [],
    },
    {
      account: B,
      admitted: true,
      placementEligible: true,
      ready: true,
      blockers: [],
    },
  ],
  selection: { account: B, pin: 'pin' },
}

for (const runtime of [
  { name: 'Node', executable: 'node' },
  { name: 'Bun', executable: process.execPath },
]) {
  test(`published limits and limits/vault import without optional peers and decideAfterLimit reroutes on ${runtime.name}`, async () => {
    const project = await mkdtemp(join(tmpdir(), 'common-auth-limits-dist-'))
    try {
      const packageRoot = join(project, 'node_modules/@cortexkit/common-auth')
      await mkdir(packageRoot, { recursive: true })
      // Keep the real export map and unbundled emitted files: source imports or
      // repository dependencies must not rescue a broken published entry.
      const manifest = await readFile(
        new URL('../../package.json', import.meta.url),
        'utf8',
      )
      await writeFile(join(packageRoot, 'package.json'), manifest)
      await cp(
        new URL('../../dist/', import.meta.url),
        join(packageRoot, 'dist'),
        { recursive: true },
      )
      await writeFile(
        join(project, 'package.json'),
        JSON.stringify({ private: true, type: 'module' }),
      )
      expect(await readdir(join(project, 'node_modules'))).toEqual([
        '@cortexkit',
      ])
      expect(await readdir(join(project, 'node_modules/@cortexkit'))).toEqual([
        'common-auth',
      ])

      const entry = join(project, 'consumer.mjs')
      await writeFile(
        entry,
        `
        import assert from 'node:assert/strict'
        import { createRequire } from 'node:module'
        import { decideAfterLimit, createRequestHistory, windowRouter } from '@cortexkit/common-auth/limits'
        import { createVaultLimitsAdapter } from '@cortexkit/common-auth/limits/vault'

        const require = createRequire(import.meta.url)
        for (const peer of ['@cortexkit/claustrum-client', '@cortexkit/subc-client']) {
          assert.throws(() => require.resolve(peer), { code: 'MODULE_NOT_FOUND' })
        }
        assert.equal(typeof createVaultLimitsAdapter, 'function')
        const decision = decideAfterLimit({
          ...${JSON.stringify(facts)},
          history: createRequestHistory({ requestId: 'dist-turn', originalUrl: '/original', clockNow: 1000 }),
        }, windowRouter)
        assert.equal(decision.action, 'reroute')
        assert.deepEqual(decision.account, ${JSON.stringify(B)})
        assert.equal(decision.retryable, true)
        assert.equal(decision.hostRetry, 'leave')
        console.log('limits and limits/vault loaded; rerouted to B')
      `,
      )
      const child = Bun.spawn([runtime.executable, entry], {
        cwd: project,
        env: { ...process.env, NODE_PATH: '' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(exit, stderr).toBe(0)
      expect(stdout.trim()).toBe(
        'limits and limits/vault loaded; rerouted to B',
      )
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  })
}
