import type {
  LimitAxes,
  LimitDecision,
  PolicyFacts,
} from '../../src/limits/index.js'
import { confirmedAffinity, decideAfterLimit } from '../../src/limits/index.js'
import type {
  ChooseAccountInput,
  ChooseAccountResult,
} from '../../src/opencode2/index.js'

/** The fixture owns policy facts; the installer supplies retry counts and wake checkpoints. */
export function limitsFixtureAdapter(
  readFacts: (input: ChooseAccountInput) => PolicyFacts,
  {
    hostRetryLimit = 10,
    axes = confirmedAffinity,
  }: {
    hostRetryLimit?: number
    axes?: LimitAxes
  } = {},
) {
  const calls: ChooseAccountInput[] = []
  const decisions: LimitDecision[] = []
  const results: ChooseAccountResult[] = []

  return {
    calls,
    decisions,
    results,
    chooseAccount(input: ChooseAccountInput): ChooseAccountResult {
      calls.push(input)
      const decision = decideAfterLimit(
        {
          ...readFacts(input),
          host: 'opencode2',
          phase: input.phase === 'retry' ? 'after-limit' : 'pre-send',
          hostPhase: input.phase,
          remainingRetries:
            input.hostAttempt === undefined
              ? undefined
              : hostRetryLimit - input.hostAttempt,
          wake: input.wake?.checkpoint
            ? { ...input.wake, checkpoint: input.wake.checkpoint }
            : undefined,
        },
        axes,
      )
      decisions.push(decision)
      const result = chooserResult(decision, input.phase)
      results.push(result)
      return result
    },
  }
}

function chooserResult(
  decision: LimitDecision,
  phase: ChooseAccountInput['phase'],
): ChooseAccountResult {
  switch (decision.action) {
    case 'hold':
      return {
        hold: {
          delayMs: decision.delayMs,
          target: decision.target,
          checkpoint: decision.checkpoint,
          kind: decision.waitKind,
        },
      }
    case 'reroute':
    case 'retain':
      return decision.account.accountId
    case 'wait-then-reselect':
      return { waitThenReselect: { delayMs: decision.delayMs } }
    case 'refuse':
    case 'pass':
    case 'exclude-for-request':
      // A request-phase refusal has no account; dispositions belong to retries.
      return phase === 'retry' ? { hostRetry: decision.hostRetry } : undefined
    default: {
      const exhaustive: never = decision
      return exhaustive
    }
  }
}
