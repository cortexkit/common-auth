import { describe, expect, test } from 'bun:test'
import type {
  IdentityBinding,
  LimitsCommand,
  LimitsMergeContext,
  LimitsNamespace,
  MergeLaw,
  TimedMarkEntry,
} from '../../src/limits/index.js'
import {
  applyLimitsCommands,
  createLimitsNamespace,
  isIdentityCompatible,
  LIMITS_HISTORY_BOUND,
  mergeAccessState,
  mergeTimedMarkEntries,
  pruneLimitsNamespace,
  retainVerifiedIdentity,
  timedMarkKeyId,
  validateIdentityFence,
} from '../../src/limits/index.js'

const account = {
  namespace: 'provider:store',
  accountId: 'a',
  incarnation: '1',
}
const binding: IdentityBinding = {
  account,
  identity: 'wire-a',
  credentialEpoch: 'epoch-1',
}
const target = { scope: { kind: 'pool' } as const, window: '5h' }
const now = 1000
type Access = { eligible: boolean }
type Snapshot = LimitsNamespace<Access>
type Command = LimitsCommand<Access>
const context: LimitsMergeContext = {
  now,
  bindings: [binding],
  authorizeEpoch: (observed, current) =>
    observed.credentialEpoch === current.credentialEpoch,
}

function empty(): Snapshot {
  return createLimitsNamespace(account.namespace, 'generation-1')
}

function mark(
  snapshot: Snapshot,
  operationId: string,
  until: number,
  mergeLaw: MergeLaw = 'overwrite',
  evidenceAt = now,
): Command {
  return {
    type: 'mark',
    producerId: 'p1',
    operationId,
    binding,
    baseRevision: snapshot.revision,
    ...target,
    mergeLaw,
    until,
    evidenceAt,
  }
}

function clear(snapshot: Snapshot, operationId: string): Command {
  return {
    type: 'clear',
    producerId: 'p1',
    operationId,
    binding,
    baseRevision: snapshot.revision,
    keys: [target],
  }
}

function access(
  snapshot: Snapshot,
  id: string,
  eligible: boolean,
  at: number,
): Command {
  return {
    type: 'access',
    producerId: 'p1',
    operationId: id,
    binding,
    baseRevision: snapshot.revision,
    state: { eligible },
    eligibilityStateUpdatedAt: at,
  }
}

function commit(snapshot: Snapshot, command: Command): Snapshot {
  const result = applyLimitsCommands(snapshot, [command], context)
  expect(result.outcomes[0]!.status).toBe('committed')
  return result.snapshot
}

function reload(snapshot: Snapshot, at = now): Snapshot {
  return pruneLimitsNamespace(JSON.parse(JSON.stringify(snapshot)), at)
}

function entry(
  until: number,
  baseRevision: number,
  committedRevision: number,
  evidenceAt = now,
): TimedMarkEntry {
  return { until, baseRevision, committedRevision, evidenceAt }
}

describe('identity compatibility and observation fences', () => {
  test('unknown matches either side; two known identities differ', () => {
    const unknown = { ...binding, identity: undefined }
    const different = { ...binding, identity: 'wire-b' }
    expect(isIdentityCompatible(binding, unknown)).toBe(true)
    expect(isIdentityCompatible(unknown, binding)).toBe(true)
    expect(isIdentityCompatible(unknown, different)).toBe(true)
    expect(isIdentityCompatible(binding, different)).toBe(false)
    for (const changed of [
      { ...account, namespace: 'other-store' },
      { ...account, accountId: 'b' },
      { ...account, incarnation: '2' },
    ]) {
      expect(
        isIdentityCompatible(binding, { ...binding, account: changed }),
      ).toBe(false)
    }
  })

  test('unknown intermediary cannot erase a verified binding', () => {
    const retained = retainVerifiedIdentity(binding, {
      ...binding,
      identity: undefined,
      credentialEpoch: 'epoch-2',
    })
    expect(retained.identity).toBe('wire-a')
    expect(retained.credentialEpoch).toBe('epoch-2')
    expect(
      isIdentityCompatible(retained, { ...binding, identity: 'wire-b' }),
    ).toBe(false)
    expect(
      retainVerifiedIdentity({ ...binding, identity: undefined }, binding),
    ).toEqual(binding)
    const replacement = {
      ...binding,
      account: { ...account, incarnation: '2' },
      identity: undefined,
    }
    expect(retainVerifiedIdentity(binding, replacement)).toEqual(replacement)
  })

  test('a refresh epoch is compatible but never bypasses custody authorization', () => {
    const refreshed = { ...binding, credentialEpoch: 'epoch-2' }
    expect(isIdentityCompatible(binding, refreshed)).toBe(true)
    const calls: IdentityBinding[] = []
    expect(
      validateIdentityFence(binding, refreshed, (observed, current) => {
        calls.push(observed, current)
        return true
      }),
    ).toBeUndefined()
    expect(calls).toEqual([binding, refreshed])
    expect(validateIdentityFence(binding, refreshed, () => false)).toBe(
      'credential-epoch',
    )
    expect(validateIdentityFence(binding, binding, () => false)).toBe(
      'credential-epoch',
    )
    expect(
      validateIdentityFence(
        binding,
        { ...binding, identity: 'wire-b' },
        () => true,
      ),
    ).toBe('identity-replaced')
  })
})

describe('timed-mark contribution algebra', () => {
  test('overwrite chooses revision, accepting shorter and zero deadlines', () => {
    const long = entry(10000, 0, 1, 2000)
    const short = entry(2000, 1, 2, 1000)
    expect(mergeTimedMarkEntries('overwrite', [short, long], now)).toEqual([
      short,
    ])
    expect(mergeTimedMarkEntries('overwrite', [long, short], 2000)).toEqual([])
    expect(
      mergeTimedMarkEntries('overwrite', [long, entry(0, 1, 2)], now),
    ).toEqual([])
  })

  test('latest-evidence breaks equal times by revision and expiry cannot revive a loser', () => {
    const long = entry(10000, 0, 1)
    const short = entry(2000, 1, 2)
    const stale = entry(20000, 2, 3, now - 1)
    expect(
      mergeTimedMarkEntries('latest-evidence', [short, stale, long], now),
    ).toEqual([short])
    expect(
      mergeTimedMarkEntries('latest-evidence', [long, short, stale], 2000),
    ).toEqual([])
    const newerEvidence = entry(3000, 0, 1, now + 1)
    expect(
      mergeTimedMarkEntries('latest-evidence', [short, newerEvidence], now),
    ).toEqual([newerEvidence])
  })

  test('max-until retains independent bases and drops dominated or duplicate entries', () => {
    const long = entry(10000, 0, 1)
    const freshShort = entry(2000, 1, 2)
    expect(mergeTimedMarkEntries('max-until', [long, freshShort], now)).toEqual(
      [long, freshShort],
    )
    const dominant = entry(12000, 1, 3)
    expect(
      mergeTimedMarkEntries(
        'max-until',
        [dominant, long, freshShort, dominant],
        now,
      ),
    ).toEqual([dominant])
    expect(
      mergeTimedMarkEntries('max-until', [long, freshShort], 2000),
    ).toEqual([long])
    expect(
      mergeTimedMarkEntries('max-until', [long, freshShort], now, 1),
    ).toEqual([freshShort])
  })

  test('access resolves equal evidence time by revision, never by eligibility', () => {
    const allowed = {
      state: true,
      eligibilityStateUpdatedAt: now,
      committedRevision: 1,
    }
    const denied = {
      state: false,
      eligibilityStateUpdatedAt: now,
      committedRevision: 2,
    }
    expect(mergeAccessState(allowed, denied)).toEqual(denied)
    expect(mergeAccessState(denied, allowed)).toEqual(denied)
    expect(
      mergeAccessState(denied, {
        ...allowed,
        eligibilityStateUpdatedAt: now + 1,
      }),
    ).toEqual({
      ...allowed,
      eligibilityStateUpdatedAt: now + 1,
    })
  })
})

describe('namespace publication and reload', () => {
  for (const law of ['overwrite', 'latest-evidence'] as const) {
    test(`${law}: long-short-expiry and long-zero leave no mark through publication and reload`, () => {
      let snapshot = empty()
      snapshot = commit(snapshot, mark(snapshot, 'long', 10000, law))
      snapshot = reload(snapshot)
      snapshot = commit(snapshot, mark(snapshot, 'short', 2000, law))
      expect(reload(snapshot).marks[0]!.entries).toEqual([entry(2000, 1, 2)])
      expect(reload(snapshot, 2000).marks).toEqual([])
      expect(reload(reload(snapshot, 2000), 3000).marks).toEqual([])
      snapshot = empty()
      snapshot = commit(snapshot, mark(snapshot, 'long', 10000, law))
      snapshot = commit(reload(snapshot), mark(snapshot, 'zero', 0, law))
      expect(snapshot.marks).toEqual([])
      expect(reload(snapshot).marks).toEqual([])
    })
  }

  test('max-until keeps the later deadline and removes dominated contributions', () => {
    let snapshot = empty()
    snapshot = commit(snapshot, mark(snapshot, 'long', 10000, 'max-until'))
    snapshot = commit(snapshot, mark(snapshot, 'short', 2000, 'max-until'))
    expect(reload(snapshot).marks[0]!.entries).toHaveLength(2)
    snapshot = commit(snapshot, mark(snapshot, 'longest', 12000, 'max-until'))
    expect(reload(snapshot).marks[0]!.entries).toEqual([entry(12000, 2, 3)])
  })

  test('access equal eligibilityStateUpdatedAt resolves by revision across reload', () => {
    let snapshot = empty()
    snapshot = commit(snapshot, access(snapshot, 'allowed', true, now))
    snapshot = commit(reload(snapshot), access(snapshot, 'denied', false, now))
    snapshot = commit(snapshot, access(snapshot, 'old-allowed', true, now - 1))
    expect(reload(snapshot).access).toEqual([
      {
        account,
        state: { eligible: false },
        eligibilityStateUpdatedAt: now,
        committedRevision: 2,
      },
    ])
  })

  test('a clear fences a delayed mark but permits post-clear evidence and does not reset access', () => {
    let snapshot = empty()
    const delayed = mark(snapshot, 'delayed', 20000)
    snapshot = commit(snapshot, mark(snapshot, 'long', 10000))
    snapshot = commit(snapshot, access(snapshot, 'denied', false, now))
    snapshot = commit(snapshot, clear(snapshot, 'clear'))
    const result = applyLimitsCommands(reload(snapshot), [delayed], context)
    expect(result.outcomes[0]!.reason).toBe('cleared')
    expect(result.snapshot.marks).toEqual([])
    expect(result.snapshot.access[0]!.state).toEqual({ eligible: false })
    snapshot = commit(result.snapshot, mark(result.snapshot, 'fresh', 3000))
    expect(reload(snapshot).marks[0]!.entries).toEqual([entry(3000, 3, 4)])
  })

  test('automatic stale headroom cannot clear newer exhaustion', () => {
    let snapshot = empty()
    const staleClear = { ...clear(snapshot, 'headroom'), evidenceAt: now }
    snapshot = commit(
      snapshot,
      mark(snapshot, 'exhausted', 10000, 'overwrite', now + 1),
    )
    const result = applyLimitsCommands(snapshot, [staleClear], context)
    expect(result.outcomes[0]!.reason).toBe('newer-evidence')
    expect(result.snapshot).toEqual(snapshot)
  })

  test('clear coverage and key encoding keep scope, window, namespace and incarnation separate', () => {
    let snapshot = empty()
    const other = {
      ...mark(snapshot, 'model', 10000),
      scope: { kind: 'model', model: 'claude' } as const,
    }
    snapshot = commit(snapshot, mark(snapshot, 'pool', 10000))
    snapshot = commit(snapshot, other)
    snapshot = commit(snapshot, clear(snapshot, 'clear-pool'))
    expect(snapshot.marks.map((m) => m.key.scope)).toEqual([
      { kind: 'model', model: 'claude' },
    ])
    const keys = [
      { ...target, account },
      {
        ...target,
        account,
        scope: { kind: 'family', family: 'claude' } as const,
      },
      {
        ...target,
        account,
        scope: { kind: 'model', model: 'claude' } as const,
      },
      { ...target, account, window: '7d' },
      { ...target, account: { ...account, namespace: 'other' } },
      { ...target, account: { ...account, incarnation: '2' } },
    ]
    expect(new Set(keys.map(timedMarkKeyId)).size).toBe(keys.length)
  })

  test('stable producer and operation ids deduplicate without reallocating a revision', () => {
    const command = mark(empty(), 'same-id', 10000)
    const snapshot = commit(empty(), command)
    const duplicate = applyLimitsCommands(reload(snapshot), [command], context)
    expect(duplicate.outcomes[0]!).toEqual({
      producerId: 'p1',
      operationId: 'same-id',
      status: 'duplicate',
      revision: 1,
    })
    expect(duplicate.snapshot).toEqual(snapshot)
    const otherProducer = { ...command, producerId: 'p2' }
    expect(commit(snapshot, otherProducer).revision).toBe(2)
  })

  test('authoritative binding inputs reject replacement but authorize a refresh or learned identity', () => {
    const command = mark(empty(), 'observed', 10000)
    const replacement = { ...binding, identity: 'wire-b' }
    expect(
      applyLimitsCommands(empty(), [command], {
        ...context,
        bindings: [replacement],
      }).outcomes[0]!.reason,
    ).toBe('identity-replaced')
    expect(
      applyLimitsCommands(empty(), [command], {
        ...context,
        bindings: [{ ...binding, account: { ...account, incarnation: '2' } }],
      }).outcomes[0]!.status,
    ).toBe('rejected')
    const refreshed = { ...binding, credentialEpoch: 'epoch-2' }
    expect(
      applyLimitsCommands(empty(), [command], {
        ...context,
        bindings: [refreshed],
      }).outcomes[0]!.reason,
    ).toBe('credential-epoch')
    expect(
      applyLimitsCommands(empty(), [command], {
        ...context,
        bindings: [refreshed],
        authorizeEpoch: () => true,
      }).outcomes[0]!.status,
    ).toBe('committed')
    const unknown = { ...command, binding: { ...binding, identity: undefined } }
    expect(
      applyLimitsCommands(empty(), [unknown], context).outcomes[0]!.status,
    ).toBe('committed')
  })

  test('merge is immutable and refuses future bases, foreign namespaces and law changes', () => {
    const initial = empty()
    const before = JSON.stringify(initial)
    const command = mark(initial, 'mark', 10000)
    const result = applyLimitsCommands(initial, [command], context)
    expect(JSON.stringify(initial)).toBe(before)
    expect(
      applyLimitsCommands(initial, [{ ...command, baseRevision: 1 }], context)
        .outcomes[0]!.reason,
    ).toBe('future-revision')
    expect(
      applyLimitsCommands(
        initial,
        [
          {
            ...command,
            binding: {
              ...binding,
              account: { ...account, namespace: 'foreign' },
            },
          },
        ],
        context,
      ).outcomes[0]!.reason,
    ).toBe('wrong-namespace')
    expect(
      applyLimitsCommands(
        result.snapshot,
        [mark(result.snapshot, 'new-law', 20000, 'max-until')],
        context,
      ).outcomes[0]!.reason,
    ).toBe('merge-law-conflict')
  })
})

describe('namespace tombstones and bounded history', () => {
  test('a restored tombstone removes lower-based entries even if committed later', () => {
    const initial = empty()
    const retained = commit(initial, clear(initial, 'clear'))
    let present: Snapshot = {
      ...empty(),
      generation: 'present-generation',
      revision: 2,
    }
    present = commit(present, {
      ...mark(present, 'stale-long', 10000, 'max-until'),
      baseRevision: 0,
    })
    present = commit(present, mark(present, 'fresh-short', 2000, 'max-until'))
    const merged = pruneLimitsNamespace(
      { ...present, tombstones: retained.tombstones },
      now,
    )
    expect(merged.generation).toBe('present-generation')
    expect(merged.revision).toBe(4)
    expect(merged.tombstones).toEqual(retained.tombstones)
    expect(merged.marks[0]!.entries).toEqual([entry(2000, 3, 4)])
    expect(reload(merged, 2000).marks).toEqual([])
  })

  test('3000 commands bound tombstones and operation ids, advance watermark and reject stale bases', () => {
    let snapshot = empty()
    for (let i = 0; i < 3000; i++) {
      const command = {
        ...clear(snapshot, `clear-${i}`),
        keys: [{ ...target, window: `window-${i}` }],
      }
      snapshot = commit(snapshot, command)
    }
    snapshot = reload(snapshot)
    expect(snapshot.revision).toBe(3000)
    expect(snapshot.tombstones).toHaveLength(LIMITS_HISTORY_BOUND)
    expect(snapshot.operationIds).toHaveLength(LIMITS_HISTORY_BOUND)
    expect(snapshot.lowWatermark).toBe(1977)
    expect(snapshot.tombstones[0]!.revision).toBe(1977)
    const stale = {
      ...mark(snapshot, 'stale', 10000),
      baseRevision: snapshot.lowWatermark - 1,
      window: 'window-0',
    }
    const rejected = applyLimitsCommands(snapshot, [stale], context)
    expect(rejected.outcomes[0]!.reason).toBe('below-watermark')
    expect(rejected.snapshot.marks).toEqual([])
    const boundary = {
      ...mark(snapshot, 'boundary', 2000),
      baseRevision: snapshot.lowWatermark,
    }
    expect(commit(snapshot, boundary).marks[0]!.entries[0]!.until).toBe(2000)
  })

  test('operation-id compaction alone advances the watermark', () => {
    let snapshot = empty()
    for (let i = 0; i <= LIMITS_HISTORY_BOUND; i++) {
      snapshot = commit(snapshot, mark(snapshot, `mark-${i}`, 10000))
    }
    expect(snapshot.tombstones).toEqual([])
    expect(snapshot.operationIds).toHaveLength(LIMITS_HISTORY_BOUND)
    expect(snapshot.lowWatermark).toBe(2)
    const stale = { ...mark(snapshot, 'forgotten-op', 2000), baseRevision: 1 }
    expect(
      applyLimitsCommands(snapshot, [stale], context).outcomes[0]!.reason,
    ).toBe('below-watermark')
  })

  test('one clear exceeding the tombstone bound leaves a usable revision at its watermark', () => {
    const command = {
      ...clear(empty(), 'many-keys'),
      keys: Array.from({ length: LIMITS_HISTORY_BOUND + 1 }, (_, i) => ({
        ...target,
        window: `${i}`,
      })),
    }
    const snapshot = commit(empty(), command)
    expect(snapshot.tombstones).toHaveLength(LIMITS_HISTORY_BOUND)
    expect(snapshot.operationIds).toHaveLength(1)
    expect(snapshot.lowWatermark).toBe(2)
    expect(snapshot.revision).toBe(2)
    const stale = { ...mark(snapshot, 'stale', 10000), baseRevision: 1 }
    expect(
      applyLimitsCommands(snapshot, [stale], context).outcomes[0]!.reason,
    ).toBe('below-watermark')
    expect(commit(snapshot, mark(snapshot, 'fresh', 2000)).revision).toBe(3)
  })
})
