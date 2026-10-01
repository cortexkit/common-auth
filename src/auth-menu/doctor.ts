import type { MenuAction, MenuContext } from './menu.js'

/** A fix the doctor can offer for one finding; applied only when chosen. */
export interface DoctorRepair {
  /** What the repair does, as the operator is asked about it. */
  label: string
  apply(): void | Promise<void>
}

export interface DoctorFinding {
  /** A stable plugin-chosen code, for tests and logs. */
  code: string
  message: string
  accountId?: string
  repair?: DoctorRepair
}

/** One plugin-registered check. A check only reads; repairs do the writing. */
export interface DoctorCheck {
  id: string
  run(): readonly DoctorFinding[] | Promise<readonly DoctorFinding[]>
}

export interface DoctorReport {
  findings: DoctorFinding[]
}

/** The code of the finding recorded for a check that threw. */
export const DOCTOR_CHECK_FAILED = 'doctor-check-failed'

/**
 * Runs every check in order. A check that throws becomes a finding of its
 * own instead of hiding what the other checks found.
 */
export async function runDoctorChecks(
  checks: readonly DoctorCheck[],
): Promise<DoctorReport> {
  const findings: DoctorFinding[] = []
  for (const check of checks) {
    try {
      findings.push(...(await check.run()))
    } catch (error) {
      findings.push({
        code: DOCTOR_CHECK_FAILED,
        message: `Check ${check.id} failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
  return { findings }
}

export function formatDoctorReport(
  title: string,
  report: DoctorReport,
): string[] {
  const lines = [title]
  if (report.findings.length === 0) {
    lines.push('No problems found.')
    return lines
  }
  for (const finding of report.findings) {
    const repair = finding.repair ? ' (repair available)' : ''
    lines.push(`- ${finding.message}${repair}`)
  }
  return lines
}

export interface RepairOutcome {
  applied: DoctorFinding[]
  declined: DoctorFinding[]
  failed: { finding: DoctorFinding; error: unknown }[]
}

/**
 * Asks about each available repair in turn and applies only the ones the
 * operator answers yes to. Without an interactive terminal every question
 * is answered no, so nothing is written.
 */
export async function applyChosenRepairs(
  context: MenuContext,
  report: DoctorReport,
): Promise<RepairOutcome> {
  const outcome: RepairOutcome = { applied: [], declined: [], failed: [] }
  for (const finding of report.findings) {
    const repair = finding.repair
    if (!repair) continue
    if (!(await context.confirm(`Apply repair: ${repair.label}?`))) {
      outcome.declined.push(finding)
      continue
    }
    try {
      await repair.apply()
      outcome.applied.push(finding)
    } catch (error) {
      outcome.failed.push({ finding, error })
      context.print(
        `Repair failed: ${repair.label}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return outcome
}

export interface DoctorActionOptions {
  checks: readonly DoctorCheck[]
  /** The report's heading; defaults to "Auth doctor". */
  title?: string
  label?: string
}

/** The menu's doctor: lists every finding, then offers each repair. */
export function doctorAction(options: DoctorActionOptions): MenuAction {
  const title = options.title ?? 'Auth doctor'
  return {
    id: 'doctor',
    label: options.label ?? 'Auth doctor',
    hint: 'check accounts and offer repairs',
    async run(context) {
      const report = await runDoctorChecks(options.checks)
      for (const line of formatDoctorReport(title, report)) context.print(line)
      const repairable = report.findings.filter((finding) => finding.repair)
      if (repairable.length === 0) {
        if (report.findings.length > 0)
          context.print('No repairs are available.')
        return
      }
      const outcome = await applyChosenRepairs(context, report)
      context.print(
        `Applied ${outcome.applied.length} of ${repairable.length} repair(s).`,
      )
    },
  }
}
