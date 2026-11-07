# Adopting per-session cache policy

`@cortexkit/common-auth/routing-accessor` reads the optional Thalamus bridge;
`@cortexkit/common-auth/cachekeep` supplies the pure `decideCacheKeep` rule. Both
are opt-in additions: the existing `CacheKeepManager` is unchanged. Plugins must
use the rule in their scheduler to adopt these modes; importing it does not
change the manager's legacy scheduling or bounds.

## Read on each decision

Call `sessionCachePolicy(sessionId)` before each request-shaping or keep-warm
decision. It looks up `globalThis[Symbol.for('cortexkit.routing')](sessionId)` and
calls the handle's synchronous `cache()` method without I/O. Never retain a
policy across requests or retain a handle for a future warm. A validated policy
has this shape:

```ts
interface SessionCachePolicy {
  ttl?: 'none' | 'short' | 'long'
  keep_warm?: 'off' | 'hours' | 'always' | 'auto'
  hours?: { from: string; to: string; tz: string }
}
```

`hours` is required only for `hours` mode and forbidden otherwise. The times are
24-hour `HH:MM`, must differ, and may cross midnight. The start is inclusive and
the end exclusive, in the explicit `tz` accepted by `Intl.DateTimeFormat`.
`ttl: 'none'` cannot accompany a warming mode. Unknown fields and invalid values
are rejected. Invalid policies return `null` with a warning once per distinct
shape; failures in getters, accessors or methods cannot break a request.

No handle, a missing/non-function `cache` method or a `null` policy means the
plugin keeps its own settings. An omitted `ttl` or `keep_warm` also leaves that
setting at the plugin's default; common-auth does not invent a default. Thalamus
resolves its configured default (`auto`) before sending a plan. Lifetimes are
requests: apply the lifetime supported by the selected provider route, not a
promise that every route can provide short or long caches. Report the lifetime
actually used.

`sessionToolWait(sessionId)` similarly returns a fresh `{ since }` for the oldest
tool call the bridge has handed to Thalamus but has not yet received an answer
for, or `null`. The timestamp is integer epoch milliseconds. A tool wait is not
required to warm: the modes permit idle warming too. A provider may support only
a subset (or no warming), and keeps that capability gate itself.

## Map standalone settings without changing defaults

When no session policy applies, map each plugin's current settings to the same
four modes, preserving its existing default:

- **anthropic-auth:** disabled becomes `off`, its clock window becomes `hours`,
  and its existing always-on setting becomes `always`. Supply `auto` with the
  plugin's cache-write and warm prices when that mode is selected.
- **openai-auth:** disabled becomes `off`, its clock window becomes `hours`, and
  `sustain` becomes `always`. Its price-less idle policy becomes `auto` with its
  existing per-model/main/subagent idle bounds.
- **antigravity-auth:** no keep-warm capability maps to `off`; it ignores warming
  modes and reports only real-response touches with an `implicit` lifetime.

Convert legacy whole-hour windows to `HH:MM` and supply the user's configured
time zone explicitly. Do not substitute the runner machine's zone for a planned
window. Standalone defaults remain plugin-owned; no shared setting is added here.

## Schedule with the shared rule

`decideCacheKeep(input)` takes `mode` (and `hours` for `hours`), `now`, `ttlMs`,
`lastRealRequestAt`, optional `lastWarmAt`, and `warmsSinceLastRealRequest`. All
times and the lifetime are milliseconds. It returns:

- `{ action: 'wait', until }`: schedule a decision at that epoch millisecond;
- `{ action: 'warm', at }`: a ping may go now, at the supplied `now`;
- `{ action: 'stop', reason }`: retire the warm plan until a later real request
  establishes new state.

The next due time is `last + ttlMs - min(30_000, ttlMs / 2)`, where `last` is the
later of the real request and the last warm. This is 4m30s for a five-minute
cache, or 59m30s for a one-hour cache. A delayed timer may still warm, but not
at or inside the final `min(5_000, ttlMs / 10)` before expiry. That cache is
considered lost: the rule stops with **`cost-cap`**, rather than replaying into a
potentially cold cache. For implicit caches, supply the plugin's own estimated
lifetime.

`hours` checks both the due time and the actual send time in its explicit zone;
a due time outside the window stops with `outside-hours`, rather than waiting
for the next opening. `hours` and `always` allow 24 warms after a real request,
then stop with `count-cap`. The count is the number already completed: 23 allows
the 24th, 24 refuses the 25th. Real requests reset the count, costs and timestamps
in the caller; warms update only the last-warm time and warm count/cost.

`auto` has no shared count cap. Optionally supply **all three** of
`warmCostSoFar`, `nextWarmCost`, and `rewriteCost`, in the same input-token-
equivalent units. These are the plugin's own provider prices; common-auth never
guesses them. Stop with `cost-cap` when
`warmCostSoFar + nextWarmCost >= rewriteCost`, including equality and before the
first warm (`warmCostSoFar: 0`). With any price missing, the helper returns the
timing decision only and the plugin must apply its own idle bounds.

`off` returns `stop/unsupported` without starting any warming. A non-positive or
non-finite lifetime also returns `unsupported`. A stop decision is not by itself
a reason to report a stop: never send `cache_warm_stopped` for a session that
never actually warmed.

## Recheck liveness before every warm

Immediately before sending a scheduled ping, re-read the routing accessor via
`sessionCachePolicy(sessionId)` and make the decision again. If a plan had been
applying and the handle disappears, its `cache` method disappears, or `cache()`
returns `null`, stop with **`session-ended`** instead of falling back to standalone
settings and continuing an abandoned warm plan. An invalid policy also returns
`null`; conservatively stop an existing planned warm in that case. For sessions
that never had a plan, `null` continues to mean standalone settings.

The caller owns session liveness, provider capability, account/credential checks,
request snapshots, timers and any send-in-flight exclusion. Replay the exact
last real request body after its request-shaping transformations (such as context
trimming and cache markers), rather than shaping it again. A warm is not a new
model step or real-request activity.

## Report after handing the reply to the host

Do not await reports on the request path. Only after the reply has reached the
host, call:

```ts
reportCacheTouch(sessionId, {
  at: providerAnsweredAt, // integer epoch milliseconds
  ttlMs: appliedTtlMs, // number, or 'implicit'
  source: 'response', // or 'warm'
})
reportCacheWarmStopped(sessionId, {
  at: stoppedAt, // integer epoch milliseconds
  reason: 'session-ended',
})
```

Touches become exactly `{ kind: 'cache_touch', at, ttl_ms, source }`, with the
lifetime actually applied by the provider. Stops become exactly
`{ kind: 'cache_warm_stopped', at, reason }`. Known stop reasons are `cost-cap`,
`count-cap`, `outside-hours`, `session-ended`, and `unsupported`, the reasons
the llm-runner contract defines; any other string is also accepted, for reasons
it adds later. Report stops only after the session has
actually warmed. Both helpers are synchronous fire-and-forget, absorb all bridge
failures, and never retry. The bridge itself retains and resends the newest
undelivered touch.
