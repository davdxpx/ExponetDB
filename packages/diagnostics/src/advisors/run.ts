import type { ControlStore, Tx } from '@exponetdb/control-store'
import { newId } from '@exponetdb/kernel'
import { TargetError } from '@exponetdb/postgres'
import { brand, getProject, type TargetRecord } from '@exponetdb/registry'
import type { AdvisorRun } from '../contract-types.ts'
import { DiagnosticsError, failureCodeOf } from '../errors.ts'
import { isoOf, onObserver, usText } from '../live.ts'
import type { SnapshotDeps } from '../snapshots.ts'
import { scopeOfProject } from '../snapshots.ts'
import {
  openSubjectFindings,
  resolveSubjectFinding,
  upsertSubjectFinding,
} from '../subject-findings.ts'
import {
  ADVISOR_CATALOG_VERSION,
  ADVISOR_RULES,
  type AdvisorCategory,
  type AdvisorFinding,
  type AdvisorRule,
  type RuleEnv,
  type SkipReason,
} from './catalog.ts'

/**
 * One run of the advisor catalog against a target (`advisor.run`,
 * [performance.md §4](../../../../exponetdb-docs/10-observability/performance.md#4-advisors)):
 *
 * 1. the rules of the requested categories read their facts on one
 *    identity-checked observer session (statement timeout 5 s, lock timeout
 *    1 s) or from the Control Store; a rule whose read fails is skipped with
 *    its reason (`timeout` for a statement timeout, `not_permitted` for a
 *    privilege error, `error` otherwise), never counted as a pass;
 * 2. one Control Store transaction records the run
 *    (`observation.advisor_runs`: who asked, the catalog version, the
 *    categories, what was skipped and why), opens or counts one finding per
 *    rule and object (`observation.subject_findings`, kind `advisor`,
 *    deduplication key `rule:object`) and resolves as `cleared` the open
 *    advisor findings of rules that ran completely and did not see them
 *    again;
 * 3. a target that cannot be read at all records a `failed` run with its
 *    code, and the read's error is returned.
 *
 * The caller's `record` (the audit event of a requested run) is written in
 * the transaction of step 2, so findings never change without it: if it
 * fails, the run and its findings are not recorded either.
 *
 * Nothing on the target changes; a fix is at most a migration draft.
 */
export type AdvisorRequester =
  | { readonly kind: 'schedule' }
  | { readonly kind: 'identity'; readonly identityId: string }

export interface AdvisorDeps extends SnapshotDeps {
  readonly store: ControlStore
}

interface RuleOutcome {
  readonly rule: AdvisorRule<never>
  readonly findings: readonly AdvisorFinding[]
  readonly complete: boolean
  readonly skipped?: SkipReason
}

/** The contract's reason for a recorded skip (see `SkipReason`). */
export function apiReason(reason: SkipReason): SkipReason {
  return reason
}

/** The skip reason of a failed fact read. */
export function skipReasonOf(error: unknown): SkipReason {
  if (error instanceof TargetError) {
    if (error.sqlstate === '57014' || error.reason === 'query_timeout') return 'timeout'
    if (error.sqlstate === '42501' || error.code === 'PERMISSION_DENIED') return 'not_permitted'
    if (error.sqlstate === '42883' || error.sqlstate === '42P01' || error.sqlstate === '42703') {
      return 'version_unsupported'
    }
  }
  return 'error'
}

/** The deduplication key of an advisor finding. */
export const advisorDedupKey = (f: Pick<AdvisorFinding, 'rule' | 'object'>): string =>
  `${f.rule}:${f.object ?? '*'}`

const SEVERITY = { info: 'info', warning: 'warning', critical: 'critical' } as const

export async function runAdvisors(
  deps: AdvisorDeps,
  target: TargetRecord,
  categories: readonly AdvisorCategory[],
  requestedBy: AdvisorRequester,
  nowMs: number = Date.now(),
  options: { readonly record?: (tx: Tx, run: AdvisorRun) => Promise<void> } = {},
): Promise<AdvisorRun> {
  const wanted = new Set(categories)
  const rules = ADVISOR_RULES.filter((r) => wanted.has(r.category))
  const project = await getProject(deps.store, target.projectId)
  if (project === undefined) throw new DiagnosticsError('TARGET_NOT_FOUND')
  const scope = scopeOfProject(project)
  const started = performance.now()
  let outcomes: RuleOutcome[]
  try {
    outcomes = await onObserver(deps, target, 'advisors', async (session) => {
      const env: RuleEnv = {
        session,
        store: deps.store,
        target,
        include: scope.includeSchemas ?? null,
        exclude: scope.excludeSchemas ?? [],
        nowMs,
      }
      const out: RuleOutcome[] = []
      for (const rule of rules) {
        try {
          const facts = await rule.facts(env)
          if ('skipped' in facts) {
            out.push({ rule, findings: [], complete: false, skipped: facts.skipped })
            continue
          }
          const findings = rule.evaluate(facts.facts as never, env).slice(0, rule.cap)
          out.push({ rule, findings, complete: facts.complete })
        } catch (error) {
          if (!session.usable) throw error
          out.push({ rule, findings: [], complete: false, skipped: skipReasonOf(error) })
        }
      }
      return out
    })
  } catch (error) {
    const durationMs = Math.round(performance.now() - started)
    await deps.store.transaction('observation.advisors.run_failed', (tx) =>
      tx.query(
        'observation.advisors.run_insert',
        `INSERT INTO observation.advisor_runs
           (advisor_run_id, target_id, generation, catalog_version, categories, requested_by, outcome,
            findings, skipped, error_code, duration_ms)
         VALUES ($1, $2, $3, $4, $5::text[], $6::jsonb, 'failed', 0, '[]'::jsonb, $7, $8)`,
        [
          newId('adv', Date.now()),
          target.targetId,
          target.generation,
          ADVISOR_CATALOG_VERSION,
          [...wanted],
          JSON.stringify(requestedBy),
          failureCodeOf(error),
          durationMs,
        ],
      ),
    )
    throw error
  }
  const durationMs = Math.round(performance.now() - started)
  const runId = newId('adv', Date.now())
  const skipped = outcomes
    .filter((o) => o.skipped !== undefined)
    .map((o) => ({ rule: o.rule.id, reason: o.skipped as SkipReason }))
  const all = outcomes.flatMap((o) => o.findings)
  return deps.store.transaction('observation.advisors.run', async (tx) => {
    const inserted = await tx.query(
      'observation.advisors.run_insert_ok',
      `INSERT INTO observation.advisor_runs
         (advisor_run_id, target_id, generation, catalog_version, categories, requested_by, outcome,
          findings, skipped, error_code, duration_ms)
       VALUES ($1, $2, $3, $4, $5::text[], $6::jsonb, $7, $8, $9::jsonb, NULL, $10)
       RETURNING ${usText('ran_at')} AS ran_at`,
      [
        runId,
        target.targetId,
        target.generation,
        ADVISOR_CATALOG_VERSION,
        [...wanted],
        JSON.stringify(requestedBy),
        skipped.length === 0 ? 'ok' : 'partial',
        all.length,
        JSON.stringify(skipped),
        durationMs,
      ],
    )
    const ranAt = inserted.rows[0]?.text('ran_at')
    if (ranAt === undefined) throw new DiagnosticsError('INTERNAL')
    const findings: AdvisorRun['findings'] = []
    const seen = new Set<string>()
    for (const f of all) {
      const dedupKey = advisorDedupKey(f)
      seen.add(dedupKey)
      const recorded = await upsertSubjectFinding(tx, {
        subject: { targetId: target.targetId },
        kind: 'advisor',
        code: f.rule,
        category: f.category,
        severity: SEVERITY[f.level],
        securityRelevant: f.category === 'security',
        dedupKey,
        summary: f.message,
        object: f.object,
        remediation: f.remediation,
        details: { evidence: f.evidence, draft: f.draft, catalogVersion: ADVISOR_CATALOG_VERSION },
        runId,
      })
      findings.push({
        rule: f.rule,
        category: f.category,
        level: f.level,
        object: f.object,
        message: f.message,
        remediation: f.remediation,
        findingId: brand('fnd', recorded.findingId),
        evidence: f.evidence,
        draft: f.draft,
      })
    }
    // Cleared: open findings of the rules that ran completely and did not see them again.
    const settled = new Set(outcomes.filter((o) => o.complete).map((o) => o.rule.id))
    const open = await openSubjectFindings(tx, target.targetId, 'advisor', [...settled])
    for (const f of open) {
      if (!seen.has(f.dedupKey)) await resolveSubjectFinding(tx, f.findingId, 'cleared', runId)
    }
    const run: AdvisorRun = {
      targetId: brand('tgt', target.targetId),
      ranAt: isoOf(ranAt),
      findings,
      id: brand('adv', runId),
      catalogVersion: ADVISOR_CATALOG_VERSION,
      skipped: skipped.map((s) => ({ rule: s.rule, reason: apiReason(s.reason) })).slice(0, 64),
    }
    await options.record?.(tx, run)
    return run
  })
}
