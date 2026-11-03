import { AsyncResource } from 'node:async_hooks'
import type { SessionActivityStore } from './activity.js'
import { createSessionActivityStore } from './activity.js'
import type { IdentityBinding } from './identity.js'
import { isIdentityCompatible, retainVerifiedIdentity } from './identity.js'
import type { LimitMarkCause } from './marker.js'
import type { LimitsCommand, LimitsNamespace } from './namespace.js'
import { applyLimitsCommands, pruneLimitsNamespace } from './namespace.js'
import type {
  LimitsPersistenceOutcome,
  LimitsPersistenceSnapshot,
  PersistenceAdapter,
} from './persistence.js'
import { LimitsPersistenceRefusal } from './persistence.js'
import { sameAccount } from './request-history.js'

export const LIMITS_REGISTRY_KEY = Symbol.for(
  '@cortexkit/common-auth/limits-registry/schema-v1',
)
const PREFIX = '@cortexkit/common-auth/limits-registry/schema-v'
const RELOAD_MS = 1000
const IDLE_MS = 5000
// Run timers and I/O in the module's async context rather than inheriting a
// caller's lock-holding callback context, which can prohibit store re-entry.
const detached = new AsyncResource('common-auth-limits')

export interface LimitsClock {
  now(): number
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(timer: unknown): void
}
const clock: LimitsClock = {
  now: () => Date.now(),
  setTimeout(callback, delay) {
    const timer = setTimeout(callback, delay)
    timer.unref?.()
    return timer
  },
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}

export interface LimitsRegistryEvent {
  readonly type: 'mark' | 'success'
  readonly command: LimitsCommand
  readonly revision: number
}
export interface LimitsRegistryOptions {
  readonly adapter: PersistenceAdapter
  readonly clock?: LimitsClock
  /** Access is provider-owned; the registry must not guess its stored shape. */
  readonly isAccessRestrictive: (state: unknown) => boolean
  readonly onEvent?: (event: LimitsRegistryEvent) => void
  readonly onRejected?: (
    command: LimitsCommand,
    outcome: LimitsPersistenceOutcome,
  ) => void
}
export interface LimitsDispatchView {
  readonly snapshot: LimitsNamespace
  /** Pending commands and identity/access restrictions only; callers still evaluate timed marks. */
  readonly blocked: boolean
}
export interface LimitsRegistry {
  readonly snapshot: LimitsNamespace
  readonly lastReloadAt: number
  readonly degradedAgreement: boolean
  readonly lastFailure: unknown
  readonly pendingCommands: number
  readonly activity: SessionActivityStore
  /** Capture before observing provider evidence, never at publication time. */
  observe(binding: IdentityBinding): {
    readonly binding: IdentityBinding
    readonly baseRevision: number
  }
  /** Synchronous; a timed mark never waits for persistence on the request path. */
  enqueue(command: LimitsCommand, event?: 'success'): void
  beforeDispatch(binding: IdentityBinding): Promise<LimitsDispatchView>
  flush(): Promise<void>
  reload(): Promise<void>
  dispose(): Promise<void>
}

export type SuccessfulProbeClear = Omit<
  Extract<LimitsCommand, { type: 'clear' }>,
  'type'
> & {
  readonly cause: LimitMarkCause
  readonly evidenceAt: number
}

/** Publish a recovery fence even when expiry already removed the observed timer.
 * Capture binding/baseRevision with observe before the probe; dispatch to that
 * account joins the clear acknowledgment through beforeDispatch, not here.
 */
export function clearLimitsAfterProbe(
  registry: LimitsRegistry,
  input: SuccessfulProbeClear,
): void {
  registry.enqueue({ ...input, type: 'clear' }, 'success')
}

interface Pending {
  readonly command: LimitsCommand
  readonly event?: 'success'
  readonly recoveryRetries?: number
}
interface Listener {
  onEvent?: LimitsRegistryOptions['onEvent']
  onRejected?: LimitsRegistryOptions['onRejected']
}
interface SchemaRegistry {
  readonly schemaVersion: 1
  readonly namespaces: Map<string, Runtime>
}

function schemaRegistry(): SchemaRegistry {
  for (const symbol of Object.getOwnPropertySymbols(globalThis)) {
    const key = Symbol.keyFor(symbol)
    if (key?.startsWith(PREFIX) && symbol !== LIMITS_REGISTRY_KEY) {
      throw new Error('limits-schema-mismatch')
    }
  }
  const current = Reflect.get(globalThis, LIMITS_REGISTRY_KEY) as
    | SchemaRegistry
    | undefined
  if (current) {
    if (current.schemaVersion !== 1 || !(current.namespaces instanceof Map))
      throw new Error('limits-schema-mismatch')
    return current
  }
  const created: SchemaRegistry = { schemaVersion: 1, namespaces: new Map() }
  Reflect.set(globalThis, LIMITS_REGISTRY_KEY, created)
  return created
}

function opId(command: { producerId: string; operationId: string }): string {
  return JSON.stringify([command.producerId, command.operationId])
}

class Runtime {
  adapter: PersistenceAdapter
  readonly clock: LimitsClock
  readonly restrictive: LimitsRegistryOptions['isAccessRestrictive']
  readonly listeners = new Set<Listener>()
  owners = 0
  readonly activity = createSessionActivityStore()
  readonly journal = new Map<string, Pending>()
  readonly failed = new Set<string>()
  readonly restrictions = new Map<
    string,
    { command: LimitsCommand; revision: number }
  >()
  snapshot!: LimitsNamespace
  recoveryView?: LimitsPersistenceSnapshot
  bindings: readonly IdentityBinding[] = []
  lastReloadAt = Number.NEGATIVE_INFINITY
  lastActivity = Number.NEGATIVE_INFINITY
  lastReadAttempt = Number.NEGATIVE_INFINITY
  generation = 0
  degradedAgreement = false
  lastFailure: unknown
  dirty = true
  live = false
  publicationTimer: unknown
  reloadTimer: unknown
  unsubscribe?: () => void
  reading?: Promise<void>
  writing?: Promise<void>
  handoff: Promise<void> = Promise.resolve()

  constructor(options: LimitsRegistryOptions) {
    this.adapter = options.adapter
    this.clock = options.clock ?? clock
    this.restrictive = options.isAccessRestrictive
  }

  fail(error: unknown): void {
    this.degradedAgreement = true
    this.lastFailure = error
  }

  reconcile(view: LimitsPersistenceSnapshot): boolean {
    if (
      view.snapshot.schemaVersion !== 1 ||
      view.snapshot.namespace !== this.adapter.namespace
    )
      throw new Error('limits-schema-mismatch')
    if (!view.authoritative) {
      // Use repaired restrictions for dispatch, but never expose an unwritten
      // recovery revision as a durable basis for new commands.
      if (
        view.degradedAgreement &&
        this.snapshot &&
        view.snapshot.revision > this.snapshot.revision
      )
        this.recoveryView = view
      this.fail(new Error('limits-unverifiable-snapshot'))
      return false
    }
    // A read started before a commit may finish after it. Never roll that commit back.
    if (
      this.snapshot &&
      view.snapshot.generation === this.snapshot.generation &&
      view.snapshot.revision < this.snapshot.revision
    )
      return false
    this.snapshot = view.snapshot
    this.recoveryView = undefined
    this.bindings = view.bindings.map((binding) => {
      const previous = this.bindings.find((b) =>
        sameAccount(b.account, binding.account),
      )
      return previous ? retainVerifiedIdentity(previous, binding) : binding
    })
    for (const [id, restriction] of this.restrictions) {
      const command = restriction.command
      const binding = this.bindings.find((b) =>
        sameAccount(b.account, command.binding.account),
      )
      const access = this.snapshot.access.find((a) =>
        sameAccount(a.account, command.binding.account),
      )
      if (
        !binding ||
        !isIdentityCompatible(binding, command.binding) ||
        (command.type === 'access' &&
          access &&
          access.committedRevision > restriction.revision &&
          access.eligibilityStateUpdatedAt >= command.eligibilityStateUpdatedAt)
      ) {
        this.restrictions.delete(id)
      }
    }
    if (view.degradedAgreement)
      this.fail(new Error('limits-envelope-recovered'))
    return !view.degradedAgreement
  }

  touch(): void {
    this.lastActivity = this.clock.now()
    this.armReload()
  }

  cancelTimers(): void {
    if (this.publicationTimer !== undefined)
      this.clock.clearTimeout(this.publicationTimer)
    if (this.reloadTimer !== undefined)
      this.clock.clearTimeout(this.reloadTimer)
    this.publicationTimer = this.reloadTimer = undefined
  }

  schedulePublish(delay: number): void {
    if (!this.live) return
    if (this.publicationTimer !== undefined)
      this.clock.clearTimeout(this.publicationTimer)
    detached.runInAsyncScope(() => {
      this.publicationTimer = this.clock.setTimeout(() => {
        this.publicationTimer = undefined
        detached.runInAsyncScope(() => {
          void this.flush()
        })
      }, delay)
    })
  }

  armReload(): void {
    if (
      !this.live ||
      this.reading ||
      this.reloadTimer !== undefined ||
      this.clock.now() - this.lastActivity >= IDLE_MS
    )
      return
    detached.runInAsyncScope(() => {
      this.reloadTimer = this.clock.setTimeout(
        () => {
          this.reloadTimer = undefined
          if (!this.live || this.clock.now() - this.lastActivity >= IDLE_MS)
            return
          detached.runInAsyncScope(() => {
            void this.reload()
          })
        },
        Math.max(0, this.lastReadAttempt + RELOAD_MS - this.clock.now()),
      )
    })
  }

  async start(adapter: PersistenceAdapter): Promise<void> {
    this.adapter = adapter
    this.live = true
    const generation = ++this.generation
    await this.reload()
    if (!this.snapshot)
      throw this.lastFailure ?? new Error('limits-hydration-failed')
    this.unsubscribe = adapter.subscribe?.(() => {
      if (!this.live || this.generation !== generation) return
      this.dirty = true
      detached.runInAsyncScope(() => {
        void this.reload()
      })
    })
    if (this.journal.size) this.schedulePublish(0)
  }

  reload(): Promise<void> {
    if (this.reading) return this.reading
    const started = this.clock.now()
    this.lastReadAttempt = started
    this.reading = detached
      .runInAsyncScope(async () => {
        try {
          this.dirty = false
          const clean = this.reconcile(await this.adapter.read(this.snapshot))
          if (clean) {
            this.lastReloadAt = started
            if (
              !this.journal.size &&
              !this.failed.size &&
              !this.restrictions.size
            ) {
              this.degradedAgreement = false
              this.lastFailure = undefined
            }
          }
        } catch (error) {
          this.dirty = true
          this.fail(error)
        }
      })
      .finally(() => {
        this.reading = undefined
        this.armReload()
      })
    return this.reading
  }

  provisional(): LimitsNamespace {
    const snapshot = this.recoveryView?.snapshot ?? this.snapshot
    const pending = [...this.journal.values()]
      .map((p) => p.command)
      .filter((c) => c.type === 'mark')
    const provisional = applyLimitsCommands(
      pruneLimitsNamespace(snapshot, this.clock.now()),
      pending,
      {
        now: this.clock.now(),
        bindings: this.bindings,
        authorizeEpoch: (a, b) => a.credentialEpoch === b.credentialEpoch,
      },
    ).snapshot
    // Pending evidence may restrict routing, but cannot invent durable revisions
    // or acknowledged operation ids for subsequent observations.
    return {
      ...this.snapshot,
      marks: provisional.marks,
      tombstones: snapshot.tombstones,
      access: snapshot.access,
    }
  }

  enqueue(command: LimitsCommand, event?: 'success'): void {
    if (command.binding.account.namespace !== this.adapter.namespace)
      throw new Error('wrong-namespace')
    const id = opId(command)
    if (
      this.journal.has(id) ||
      this.snapshot.operationIds.some((op) => opId(op) === id)
    )
      return
    this.journal.set(id, { command: structuredClone(command), event })
    this.touch()
    // A control must include all earlier evidence, even if the mark debounce has not fired.
    const hasControl = [...this.journal.values()].some(
      (p) => p.command.type !== 'mark',
    )
    this.schedulePublish(hasControl ? 0 : RELOAD_MS)
  }

  flush(): Promise<void> {
    if (this.writing) return this.writing
    if (!this.journal.size) return Promise.resolve()
    this.writing = detached
      .runInAsyncScope(async () => {
        let batch = [...this.journal.values()]
        while (batch.length) {
          try {
            const result = await this.adapter.commit(
              batch.map((p) => p.command),
              this.snapshot,
            )
            this.reconcile(result)
            if (!result.authoritative)
              throw new Error('limits-unverifiable-commit')
            for (const pending of batch) {
              const outcome = result.outcomes.find(
                (o) => opId(o) === opId(pending.command),
              )
              if (!outcome) throw new Error('limits-missing-acknowledgement')
              this.settle(pending, outcome)
            }
          } catch (error) {
            if (
              error instanceof LimitsPersistenceRefusal &&
              error.code === 'pool-not-ready'
            ) {
              for (const pending of batch)
                this.settle(pending, {
                  ...pending.command,
                  status: 'rejected',
                  reason: 'pool-not-ready',
                })
            } else {
              for (const pending of batch)
                if (this.journal.has(opId(pending.command)))
                  this.failed.add(opId(pending.command))
              this.fail(error)
              break
            }
          }
          const remaining = [...this.journal.values()]
          const lastControl = remaining.findLastIndex(
            (p) => p.command.type !== 'mark',
          )
          // Marks arriving while adapter.commit() runs retain their own debounce.
          // Only a later control needs earlier marks in its acknowledgement.
          batch = remaining.slice(0, lastControl + 1)
        }
      })
      .finally(() => {
        this.writing = undefined
        if (this.journal.size && this.live) this.schedulePublish(RELOAD_MS)
        if (this.degradedAgreement && this.live) this.armReload()
      })
    return this.writing
  }

  settle(pending: Pending, outcome: LimitsPersistenceOutcome): void {
    const command = pending.command
    const id = opId(command)
    this.journal.delete(id)
    this.failed.delete(id)
    if (outcome.status === 'rejected') {
      this.fail(new Error(outcome.reason ?? 'limits-command-rejected'))
      if (command.type === 'access' && this.restrictive(command.state)) {
        this.restrictions.set(id, { command, revision: this.snapshot.revision })
        // Recovery rejects pre-barrier observations. Restrictive access alone
        // can be resubmitted at that barrier without granting availability.
        // Repeated competing recoveries must not keep a dispatch waiting forever;
        // after three retries, keep the account blocked and agreement degraded
        // instead of retrying again.
        if (
          outcome.reason === 'below-watermark' &&
          command.baseRevision < this.snapshot.lowWatermark &&
          (pending.recoveryRetries ?? 0) < 3
        ) {
          this.journal.set(id, {
            ...pending,
            recoveryRetries: (pending.recoveryRetries ?? 0) + 1,
            command: { ...command, baseRevision: this.snapshot.revision },
          })
        }
      }
      for (const listener of this.listeners) {
        try {
          listener.onRejected?.(command, outcome)
        } catch {
          /* Observers cannot change settlement. */
        }
      }
    } else if (
      outcome.revision !== undefined &&
      (command.type === 'mark' || pending.event === 'success')
    ) {
      for (const listener of this.listeners) {
        try {
          listener.onEvent?.({
            type: command.type === 'mark' ? 'mark' : 'success',
            command,
            revision: outcome.revision,
          })
        } catch {
          /* Observers cannot change settlement. */
        }
      }
    }
  }

  async beforeDispatch(binding: IdentityBinding): Promise<LimitsDispatchView> {
    this.touch()
    const controls = () =>
      [...this.journal.values()].some(
        (p) =>
          p.command.type !== 'mark' &&
          sameAccount(p.command.binding.account, binding.account),
      )
    if (controls()) await this.flush()
    if (this.dirty || this.clock.now() - this.lastReloadAt >= RELOAD_MS)
      await this.reload()
    const current = (this.recoveryView?.bindings ?? this.bindings).find((b) =>
      sameAccount(b.account, binding.account),
    )
    const snapshot = this.provisional()
    return {
      snapshot,
      blocked:
        controls() ||
        !current ||
        !isIdentityCompatible(current, binding) ||
        [...this.restrictions.values()].some((r) =>
          sameAccount(r.command.binding.account, binding.account),
        ) ||
        [...this.snapshot.access, ...snapshot.access].some(
          (a) =>
            sameAccount(a.account, binding.account) &&
            this.restrictive(a.state),
        ),
    }
  }

  async stop(): Promise<void> {
    this.live = false
    this.generation++
    this.cancelTimers()
    await this.flush()
    await this.reading
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.cancelTimers()
  }
}

/** Shared owners use one journal/listener; a last-owner replacement waits for handoff. */
export async function acquireLimitsRegistry(
  options: LimitsRegistryOptions,
): Promise<LimitsRegistry> {
  const registry = schemaRegistry()
  let runtime = registry.namespaces.get(options.adapter.namespace)
  if (!runtime) {
    runtime = new Runtime(options)
    registry.namespaces.set(options.adapter.namespace, runtime)
  }
  const state = runtime
  const listener: Listener = {
    onEvent: options.onEvent,
    onRejected: options.onRejected,
  }
  // Reserve the owner synchronously so concurrent acquisitions cannot start two listeners.
  const first = state.owners++ === 0
  state.listeners.add(listener)
  if (first)
    state.handoff = state.handoff
      .catch(() => {})
      .then(() => state.start(options.adapter))
  try {
    await state.handoff
  } catch (error) {
    state.listeners.delete(listener)
    state.owners--
    state.live = false
    state.cancelTimers()
    throw error
  }
  let disposed = false
  const active = () => {
    if (disposed) throw new Error('limits-registry-disposed')
  }
  return {
    get snapshot() {
      active()
      return state.provisional()
    },
    get lastReloadAt() {
      return state.lastReloadAt
    },
    get degradedAgreement() {
      return state.degradedAgreement
    },
    get lastFailure() {
      return state.lastFailure
    },
    get pendingCommands() {
      return state.journal.size
    },
    activity: state.activity,
    observe(binding) {
      active()
      return {
        binding: structuredClone(binding),
        baseRevision: state.snapshot.revision,
      }
    },
    enqueue(command, event) {
      active()
      state.enqueue(command, event)
    },
    beforeDispatch(binding) {
      active()
      return state.beforeDispatch(binding)
    },
    flush() {
      active()
      return state.flush()
    },
    reload() {
      active()
      return state.reload()
    },
    dispose() {
      if (disposed) return state.handoff
      disposed = true
      state.owners--
      if (!state.owners) {
        state.handoff = state.handoff
          .then(() => state.stop())
          .finally(() => state.listeners.delete(listener))
      } else {
        state.listeners.delete(listener)
      }
      return state.handoff
    },
  }
}
