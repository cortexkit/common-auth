import { describe, expect, test } from 'bun:test'
import {
  ATTEMPT_HEADER,
  type ChooseAccountInput,
  installOpenCode2Auth,
} from '../../src/opencode2/index.js'
import { fakeAdapter, fakeHost, PROVIDER, scopeFor } from './fake-host.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function setup(options: { maxRecords?: number } = {}) {
  const host = fakeHost()
  const choices: ChooseAccountInput[] = []
  const drops: Array<ChooseAccountInput & { accountId: string }> = []
  const warnings: unknown[] = []
  let answer: string | undefined = 'A'
  let chooseError = false
  let onChoose:
    | ((input: ChooseAccountInput) => Promise<string | undefined>)
    | undefined
  let onDrop: (() => Promise<void>) | undefined
  const { adapter } = fakeAdapter(undefined, {
    chooseAccount(input) {
      choices.push(input)
      if (chooseError) throw new Error('choose failed')
      return onChoose ? onChoose(input) : answer
    },
    dropChoice: async (input) => {
      drops.push(input)
      await onDrop?.()
    },
    limitFromError: () => ({ reason: 'refused' }),
  })
  const installation = await installOpenCode2Auth(host.ctx, adapter, {
    ...options,
    logger: {
      warn: (...args) => {
        warnings.push(args)
      },
    },
  })
  const request = (scope = scopeFor()) =>
    host.fire('model.request', { ...scope, headers: {} })
  const retry = (decision = { retry: true, delay: 123 }) =>
    host.fire('retry', {
      ...scopeFor(),
      error: { type: 'provider.unknown', message: 'refused' },
      attempt: 1,
      decision,
    })
  await request()
  return {
    host,
    installation,
    choices,
    drops,
    warnings,
    request,
    retry,
    answer(value: string | undefined) {
      answer = value
    },
    throwChoose(value = true) {
      chooseError = value
    },
    onChoose(
      value: (input: ChooseAccountInput) => Promise<string | undefined>,
    ) {
      onChoose = value
    },
    onDrop(value: () => Promise<void>) {
      onDrop = value
    },
  }
}

const retryInput: ChooseAccountInput = {
  providerID: PROVIDER,
  modelID: 'mock-model',
  sessionID: 'ses_1',
  agent: 'build',
  kind: 'primary',
  previousAccountId: 'A',
  rerouteFrom: { accountId: 'A', limit: { reason: 'refused' } },
  phase: 'retry',
}

describe('committed retry choice', () => {
  test('last account is kept after the host wait without a second choice', async () => {
    const s = await setup()
    const reasons: string[] = []
    s.installation.on('retry', (event) => {
      reasons.push(event.reason)
    })
    expect((await s.retry()).decision).toEqual({ retry: true, delay: 123 })
    s.answer('B')
    await s.request()
    expect(s.choices).toHaveLength(2)
    expect(s.choices[1]).toEqual(retryInput)
    expect(s.installation.accountFor('ses_1', 'primary')).toBe('A')
    expect(reasons).toEqual(['host-decides-last-account'])
    expect(s.drops).toEqual([])
    await s.installation.dispose()
    expect(s.drops).toEqual([])
  })

  test('reroute is kept without a second choice, even if it becomes unavailable', async () => {
    const s = await setup()
    s.answer('B')
    expect((await s.retry()).decision).toEqual({ retry: true, delay: 0 })
    s.answer(undefined)
    await s.request()
    expect(s.choices).toHaveLength(2)
    expect(s.choices[1]).toEqual(retryInput)
    expect(s.installation.accountFor('ses_1', 'primary')).toBe('B')
    expect(s.drops).toEqual([])
    expect((await s.retry()).decision).toEqual({ retry: true, delay: 123 })
    await s.installation.dispose()
  })

  test('undefined commits nothing and the next request chooses without rerouteFrom', async () => {
    const s = await setup()
    s.answer(undefined)
    await s.retry()
    s.answer('B')
    await s.request()
    expect(s.choices).toEqual([
      {
        providerID: PROVIDER,
        modelID: 'mock-model',
        sessionID: 'ses_1',
        agent: 'build',
        kind: 'primary',
        phase: 'request',
      },
      retryInput,
      {
        providerID: PROVIDER,
        modelID: 'mock-model',
        sessionID: 'ses_1',
        agent: 'build',
        kind: 'primary',
        previousAccountId: 'A',
        phase: 'request',
      },
    ])
    expect(s.drops).toEqual([])
    await s.installation.dispose()
  })

  test('a thrown retry choice commits nothing', async () => {
    const s = await setup()
    s.throwChoose()
    await s.retry()
    expect(s.warnings).toHaveLength(1)
    s.throwChoose(false)
    await s.request()
    expect(s.choices).toHaveLength(3)
    expect(s.choices[2]).toMatchObject({
      phase: 'request',
      previousAccountId: 'A',
    })
    expect(s.choices[2]?.rerouteFrom).toBeUndefined()
    expect(s.drops).toEqual([])
    await s.installation.dispose()
  })

  test('host no retry drops the last-account choice exactly once', async () => {
    const s = await setup()
    expect((await s.retry({ retry: false, delay: 456 })).decision).toEqual({
      retry: false,
      delay: 456,
    })
    expect(s.drops).toEqual([{ ...retryInput, accountId: 'A' }])
    await s.installation.dispose()
    expect(s.drops).toHaveLength(1)
  })

  for (const changed of ['model', 'agent'] as const) {
    test(`${changed} change drops the full choice before choosing afresh`, async () => {
      const s = await setup()
      s.answer('B')
      await s.retry()
      const scope = scopeFor()
      if (changed === 'model') scope.model.id = 'other-model'
      else scope.agent = 'other-agent'
      s.answer('C')
      await s.request(scope)
      expect(s.drops).toEqual([{ ...retryInput, accountId: 'B' }])
      expect(s.choices).toHaveLength(3)
      expect(s.choices[2]).toEqual({
        providerID: PROVIDER,
        modelID: scope.model.id,
        sessionID: 'ses_1',
        agent: scope.agent,
        kind: 'primary',
        previousAccountId: 'A',
        rerouteFrom: retryInput.rerouteFrom,
        phase: 'request',
      })
      expect(s.installation.accountFor('ses_1', 'primary')).toBe('C')
      await s.installation.dispose()
      expect(s.drops).toHaveLength(1)
    })
  }

  test('model change awaits dropChoice before the fresh chooseAccount enters', async () => {
    const s = await setup()
    s.answer('B')
    await s.retry()
    const entered = deferred()
    const release = deferred()
    s.onDrop(async () => {
      entered.resolve()
      await release.promise
    })
    const next = s.request({
      ...scopeFor(),
      model: { providerID: PROVIDER, id: 'new-model' },
    })
    // Race against completion so a missing drop fails rather than hanging the test.
    await Promise.race([entered.promise, next])
    expect(s.choices).toHaveLength(2)
    expect(s.drops).toHaveLength(1)
    release.resolve()
    await next
    expect(s.choices).toHaveLength(3)
    await s.installation.dispose()
  })

  for (const cleanup of [
    'forgetSession',
    'session.deleted',
    'dispose',
    'eviction',
  ] as const) {
    test(`${cleanup} drops an unused choice exactly once`, async () => {
      const s = await setup({ maxRecords: 1 })
      s.answer('B')
      await s.retry()
      if (cleanup === 'forgetSession') s.installation.forgetSession('ses_1')
      else if (cleanup === 'session.deleted')
        await s.host.publish('session.deleted', { sessionID: 'ses_1' })
      else if (cleanup === 'dispose') await s.installation.dispose()
      else await s.request(scopeFor('primary', 'ses_other'))
      // Reuse of the forgotten id must wait for cleanup, even though forgetting is synchronous.
      if (cleanup !== 'dispose') await s.request()
      expect(s.drops).toEqual([{ ...retryInput, accountId: 'B' }])
      await s.installation.dispose()
      expect(s.drops).toHaveLength(1)
    })
  }

  test('a throwing dropChoice is logged and does not break the next request', async () => {
    const s = await setup()
    s.answer('B')
    await s.retry()
    s.onDrop(async () => {
      throw new Error('drop failed')
    })
    await s.request({ ...scopeFor(), agent: 'other-agent' })
    expect(s.drops).toEqual([{ ...retryInput, accountId: 'B' }])
    expect(s.choices).toHaveLength(3)
    expect(JSON.stringify(s.warnings)).toContain('drop failed')
    await s.installation.dispose()
  })

  test('evicting the retry owner releases its choice even with another attempt of the same kind held', async () => {
    const s = await setup({ maxRecords: 2 })
    await s.request()
    const sent = await s.host.fire('http.request', {
      ...scopeFor(),
      request: new Request('https://provider.invalid', {
        headers: { [ATTEMPT_HEADER]: 'attempt-1' },
      }),
    })
    await s.host.fire('http.response', {
      ...scopeFor(),
      request: sent.request,
      response: new Response(null, { status: 429 }),
    })
    s.answer('B')
    await s.retry()
    await s.request(scopeFor('primary', 'ses_other'))
    await s.request()
    expect(s.drops).toHaveLength(1)
    expect(s.drops[0]).toEqual({
      ...retryInput,
      rerouteFrom: {
        accountId: 'A',
        limit: { reason: 'too-many', status: 429 },
      },
      accountId: 'B',
    })
    await s.installation.dispose()
    expect(s.drops).toHaveLength(1)
  })

  test('forgetting queues release before a different kind reuses the session', async () => {
    const s = await setup()
    s.answer('B')
    await s.retry()
    const entered = deferred()
    const release = deferred()
    s.onDrop(async () => {
      entered.resolve()
      await release.promise
    })
    s.installation.forgetSession('ses_1')
    const next = s.request(scopeFor('title'))
    await Promise.race([entered.promise, next])
    expect(s.choices).toHaveLength(2)
    release.resolve()
    await next
    expect(s.choices[2]).toMatchObject({ kind: 'title', phase: 'request' })
    expect(s.choices[2]?.previousAccountId).toBeUndefined()
    expect(s.drops).toEqual([{ ...retryInput, accountId: 'B' }])
    await s.installation.dispose()
  })

  test('forgetting during the retry choice releases its answer before session reuse', async () => {
    const s = await setup()
    const choosing = deferred()
    const answer = deferred()
    s.onChoose(async (input) => {
      if (input.phase !== 'retry') return 'C'
      choosing.resolve()
      await answer.promise
      return 'B'
    })
    const retried = s.retry().catch((error: unknown) => error)
    await choosing.promise
    s.installation.forgetSession('ses_1')
    const dropped = deferred()
    const release = deferred()
    s.onDrop(async () => {
      dropped.resolve()
      await release.promise
    })
    const next = s.request()
    answer.resolve()
    await Promise.race([dropped.promise, next])
    expect(s.choices).toHaveLength(2)
    expect(s.drops).toEqual([{ ...retryInput, accountId: 'B' }])
    release.resolve()
    expect(await retried).toBeInstanceOf(Error)
    await next
    expect(s.choices).toHaveLength(3)
    expect(s.installation.accountFor('ses_1', 'primary')).toBe('C')
    await s.installation.dispose()
    expect(s.drops).toHaveLength(1)
  })
})
