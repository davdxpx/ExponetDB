import { type Clock, formatTimestamp, systemClock } from '@exponetdb/kernel'

/**
 * Liveness and readiness ([health.md §8](../../../exponetdb-docs/10-observability/health.md#8-control-plane-health)).
 *
 * - **Liveness**: the process runs and its event loop answers. Nothing else.
 * - **Readiness**: the process can safely do its role's work now. It is the
 *   combination of named checks. A check that throws, times out or has not
 *   run yet counts as failed: readiness is never green by catch-and-default
 *   (C-28). A failing `critical` check makes the process `not_ready`; a
 *   failing `degrading` check (or a `warn` result) makes it `degraded`.
 *
 * Check results carry machine reason codes (`schema_unverified`,
 * `keyring_invalid`, …), never error text, connection strings, role names or
 * SQL. Only the overall status leaves the process publicly; the per-check
 * detail is served on the internal listener.
 */
export type CheckStatus = 'pass' | 'warn' | 'fail'
export type ReadinessStatus = 'ready' | 'degraded' | 'not_ready'

export interface CheckOutcome {
  readonly status: CheckStatus
  /** Machine code, `lower_snake`. Required unless `pass`. */
  readonly reason?: string
}

export interface HealthCheck {
  readonly name: string
  readonly severity: 'critical' | 'degrading'
  readonly timeoutMs?: number
  run(): Promise<CheckOutcome>
}

export interface CheckReport {
  readonly name: string
  readonly severity: 'critical' | 'degrading'
  readonly status: CheckStatus
  readonly reason?: string
  readonly durationMs: number
}

export interface ReadinessReport {
  readonly status: ReadinessStatus
  readonly evaluatedAt: string
  readonly checks: readonly CheckReport[]
}

const REASON = /^[a-z][a-z0-9_]{0,63}$/

export const pass = (): CheckOutcome => ({ status: 'pass' })
export const warn = (reason: string): CheckOutcome => ({ status: 'warn', reason })
export const fail = (reason: string): CheckOutcome => ({ status: 'fail', reason })

function sanitizeReason(reason: string | undefined, status: CheckStatus): string | undefined {
  if (status === 'pass') {
    return undefined
  }
  return reason !== undefined && REASON.test(reason) ? reason : 'unspecified'
}

async function runOne(check: HealthCheck, clock: Clock): Promise<CheckReport> {
  const started = clock.nowMs()
  const timeoutMs = check.timeoutMs ?? 5000
  let timer: NodeJS.Timeout | undefined
  try {
    const outcome = await Promise.race([
      check.run(),
      new Promise<CheckOutcome>((resolve) => {
        timer = setTimeout(() => resolve(fail('check_timeout')), timeoutMs)
        timer.unref()
      }),
    ])
    const reason = sanitizeReason(outcome.reason, outcome.status)
    return {
      name: check.name,
      severity: check.severity,
      status: outcome.status,
      ...(reason === undefined ? {} : { reason }),
      durationMs: clock.nowMs() - started,
    }
  } catch {
    return {
      name: check.name,
      severity: check.severity,
      status: 'fail',
      reason: 'check_error',
      durationMs: clock.nowMs() - started,
    }
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

export function combine(checks: readonly CheckReport[]): ReadinessStatus {
  if (checks.some((c) => c.severity === 'critical' && c.status === 'fail')) {
    return 'not_ready'
  }
  if (checks.some((c) => c.status !== 'pass')) {
    return 'degraded'
  }
  return 'ready'
}

/** Evaluates registered checks; `latest()` is what the probes serve. */
export class Readiness {
  readonly #checks: HealthCheck[] = []
  readonly #clock: Clock
  #latest: ReadinessReport
  #stopping = false

  constructor(clock: Clock = systemClock) {
    this.#clock = clock
    this.#latest = {
      status: 'not_ready',
      evaluatedAt: formatTimestamp(clock.nowMs()),
      checks: [
        {
          name: 'startup',
          severity: 'critical',
          status: 'fail',
          reason: 'not_evaluated',
          durationMs: 0,
        },
      ],
    }
  }

  register(check: HealthCheck): void {
    if (
      !/^[a-z][a-z0-9_.]{0,63}$/.test(check.name) ||
      this.#checks.some((c) => c.name === check.name)
    ) {
      throw new Error(`invalid or duplicate check name: ${check.name}`)
    }
    this.#checks.push(check)
  }

  /** Marks the process as shutting down: readiness turns `not_ready` and stays there. */
  markStopping(): void {
    this.#stopping = true
    this.#latest = this.#stoppingReport()
  }

  get stopping(): boolean {
    return this.#stopping
  }

  #stoppingReport(): ReadinessReport {
    return {
      status: 'not_ready',
      evaluatedAt: formatTimestamp(this.#clock.nowMs()),
      checks: [
        {
          name: 'lifecycle',
          severity: 'critical',
          status: 'fail',
          reason: 'stopping',
          durationMs: 0,
        },
      ],
    }
  }

  async evaluate(): Promise<ReadinessReport> {
    if (this.#stopping) {
      return this.#latest
    }
    const reports = await Promise.all(this.#checks.map((c) => runOne(c, this.#clock)))
    const checks =
      reports.length === 0
        ? [
            {
              name: 'checks',
              severity: 'critical' as const,
              status: 'fail' as const,
              reason: 'no_checks',
              durationMs: 0,
            },
          ]
        : reports
    const report: ReadinessReport = {
      status: combine(checks),
      evaluatedAt: formatTimestamp(this.#clock.nowMs()),
      checks,
    }
    if (!this.#stopping) {
      this.#latest = report
    }
    return this.#latest
  }

  latest(): ReadinessReport {
    return this.#latest
  }
}

/** Public projection: status only, never check names or reasons. */
export function publicReadiness(report: ReadinessReport): { readonly status: ReadinessStatus } {
  return { status: report.status }
}

/** HTTP status for a readiness probe: 503 only when not ready. */
export function readinessHttpStatus(status: ReadinessStatus): 200 | 503 {
  return status === 'not_ready' ? 503 : 200
}
