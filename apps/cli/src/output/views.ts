import type { Operation, PlanView } from '@exponetdb/sdk'
import { dash, toneOf } from './format.ts'
import type { Block } from './model.ts'
import { nodeChangeBlocks } from './node-plans.ts'

/**
 * The plan and operation views every command shares
 * ([`15-cli/README.md` §6](../../../../exponetdb-docs/15-cli/README.md#6-watching-operations)).
 * Nothing here decides: the decision, requirements, outcomes and next
 * action are the server's; the view only arranges them. A failed
 * verification is never shown as a success.
 */
type Json = unknown

function obj(v: Json): Record<string, Json> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, Json>)
    : undefined
}

const str = (v: Json): string | undefined => (typeof v === 'string' ? v : undefined)

function requirementLine(r: PlanView['requirements'][number]): string {
  switch (r.kind) {
    case 'approval':
      return `${r.count} human approval${r.count === 1 ? '' : 's'} for the exact plan hash (plans.approve)`
    case 'reauth':
      return `a fresh re-authentication (within ${r.withinSeconds}s) of the person who applies`
    case 'backup':
      return `a verified backup newer than ${r.newerThan}`
    case 'maintenance_window':
      return `the maintenance window ${r.windowId}`
    case 'break_glass':
      return `break-glass for ${r.rules.join(', ')}`
  }
}

function decisionText(p: PlanView): string {
  if (p.decision === 'allow') return 'allowed'
  if (p.decision === 'deny') return 'denied'
  return p.requirements.some((r) => r.kind === 'approval')
    ? 'approval required'
    : 'requirements apply'
}

const KIND_TITLES: Record<string, string> = {
  'migration.apply': 'Migration plan',
  'migration.resume': 'Migration resume plan',
  'migration.rollback': 'Migration rollback plan',
  'migration.import.replay': 'Legacy import analysis plan',
  'migration.baseline': 'Baseline plan',
}

export function planTitle(p: Pick<PlanView, 'kind' | 'id'>): string {
  return `${KIND_TITLES[p.kind] ?? `Plan ${p.kind}`} · ${p.id}`
}

/** The migration rows of a migration plan's content, when it has them. */
function migrationRows(p: PlanView): Block[] {
  const content = obj(p.change?.content)
  const analysis = obj(p.change?.analysis)
  const list = content?.['migrations']
  const migrations: Json[] = Array.isArray(list) ? list : []
  if (migrations.length === 0) return []
  const perList = analysis?.['perMigration']
  const per: Json[] = Array.isArray(perList) ? perList : []
  const rows = migrations.map((m, i) => {
    const mo = obj(m) ?? {}
    const a = obj(per[i]) ?? {}
    const lock = str(a['lockSeverity']) ?? str(obj(a['locks'])?.['strongest']) ?? '-'
    return [
      `${dash(str(mo['migrationId']))}_${dash(str(mo['name']))}`,
      dash(str(mo['checksum'])),
      typeof mo['verifyChecks'] === 'number' ? `${mo['verifyChecks']} checks` : '-',
      mo['transactional'] === false ? 'nontransactional' : 'transactional',
      lock,
    ]
  })
  return [
    {
      kind: 'table',
      columns: [
        { title: 'MIGRATION', flexible: true },
        { title: 'APPLY CHECKSUM', flexible: true },
        { title: 'VERIFY' },
        { title: 'MODE' },
        { title: 'LOCK' },
      ],
      rows,
    },
  ]
}

function migrationFacts(p: PlanView): [string, string][] {
  const content = obj(p.change?.content)
  const facts = obj(content?.['facts'])
  if (facts === undefined) return []
  const list = content?.['migrations']
  const migrations = Array.isArray(list) ? list.length : 0
  const execution = obj(content?.['execution'])
  return [
    [
      'Content',
      `${migrations} bundle${migrations === 1 ? '' : 's'} · ${dash(str(execution?.['mode']))}`,
    ],
    ['Compatibility', dash(str(facts['compatibility']))],
    ['Evidence', dash(str(facts['evidence']))],
    ['Lineage', dash(str(facts['lineage']))],
  ]
}

export function planBlocks(p: PlanView): Block[] {
  const blocks: Block[] = []
  blocks.push({
    kind: 'fields',
    rows: [
      [
        'Target',
        p.subject.targetPath ??
          p.subject.targetId ??
          p.subject.clusterId ??
          p.subject.nodeId ??
          'installation',
      ],
      ['Tier', p.subject.tier],
      ['Kind', `${p.kind} (${p.class})`],
      ['State', p.state],
      ['Decision', decisionText(p)],
      ['Expires', p.expiresAt],
      ['Plan hash', p.planHash],
      ...migrationFacts(p),
      ...(p.approvals.required > 0
        ? [['Approvals', `${p.approvals.given} of ${p.approvals.required}`] as [string, string]]
        : []),
      ...(p.overriddenRules.length > 0
        ? [['Overridden', p.overriddenRules.join(', ')] as [string, string]]
        : []),
    ],
  })
  blocks.push(...migrationRows(p))
  // The change of a node plan (TC-001): what a person judges before applying it.
  blocks.push(...nodeChangeBlocks(p))
  const failing = (p.policyRules ?? []).filter(
    (r) => r.result !== 'pass' && r.result !== 'not_applicable',
  )
  if (failing.length > 0) {
    blocks.push({
      kind: 'table',
      columns: [
        { title: 'RULE' },
        { title: 'RESULT' },
        { title: 'SEVERITY' },
        { title: 'MESSAGE', flexible: true },
      ],
      rows: failing.map((r) => [r.id, r.result, r.severity, r.message]),
    })
  }
  if (p.requirements.length > 0) {
    blocks.push({
      kind: 'text',
      lines: p.requirements.map((r) => `Required: ${requirementLine(r)}`),
    })
  }
  return blocks
}

/** What to run next for a plan in its current state. */
export function planNext(p: PlanView): string[] {
  if (p.state !== 'active') return []
  if (p.decision === 'deny') {
    const remediations = (p.policyRules ?? []).flatMap((r) =>
      r.remediation === undefined ? [] : [r.remediation],
    )
    return remediations.length > 0 ? remediations : ['Fix the denying rule, then plan again.']
  }
  return [`exponetdb plan apply ${p.id} --wait`]
}

const OUTCOME_WORDS: Record<Operation['state'], string> = {
  awaiting_approval: 'Awaiting approval',
  queued: 'Queued',
  running: 'Running',
  verifying: 'Verifying',
  needs_reconciliation: 'Reconciling the outcome',
  needs_attention: 'Needs attention',
  succeeded: 'Succeeded (applied and verified)',
  failed: 'Failed',
  verification_failed: 'Verification failed',
  canceled: 'Canceled',
}

export function operationBlocks(o: Operation): Block[] {
  const blocks: Block[] = [
    { kind: 'status', word: OUTCOME_WORDS[o.state], tone: toneOf(o.state) },
    {
      kind: 'fields',
      rows: [
        ['Apply', o.applyOutcome],
        ['Verification', o.verificationOutcome],
        [
          'Target',
          o.subject.targetPath ??
            o.subject.targetId ??
            o.subject.clusterId ??
            o.subject.nodeId ??
            'installation',
        ],
        ['Tier', o.subject.tier],
        ['Plan', o.planId],
        ...(o.errorCode === null ? [] : [['Error', o.errorCode] as [string, string]]),
        ...(o.waitingFor === null
          ? []
          : [['Waiting for', o.waitingFor.operationId] as [string, string]]),
        ...(o.approvalUrl === null ? [] : [['Approve at', o.approvalUrl] as [string, string]]),
        ['Updated', o.updatedAt],
        ...(o.observedAt === undefined ? [] : [['Observed', o.observedAt] as [string, string]]),
      ],
    },
  ]
  if (o.steps.length > 0) {
    blocks.push({
      kind: 'table',
      columns: [{ title: 'STEP' }, { title: 'STATE' }, { title: 'STARTED' }, { title: 'FINISHED' }],
      rows: o.steps.map((s) => [s.name, s.state, dash(s.startedAt), dash(s.finishedAt)]),
    })
  }
  if (o.migrations !== undefined && o.migrations.length > 0) {
    blocks.push({
      kind: 'table',
      columns: [
        { title: 'MIGRATION', flexible: true },
        { title: 'APPLY' },
        { title: 'VERIFY' },
        { title: 'STATEMENT', align: 'right' },
        { title: 'ERROR' },
      ],
      rows: o.migrations.map((m) => [
        `${m.migrationId}_${m.name}`,
        m.applyOutcome,
        m.verificationOutcome,
        m.statementIndex === null ? '-' : String(m.statementIndex),
        m.errorCode ?? m.sqlstate ?? '-',
      ]),
    })
    const gates = o.migrations.flatMap((m) =>
      m.gate === undefined
        ? []
        : [
            `${m.migrationId}: the ${m.gate.layer} gate failed ${m.gate.failed} of ${m.gate.checks} assertions; first: ${m.gate.first}`,
          ],
    )
    if (gates.length > 0) blocks.push({ kind: 'text', lines: gates, tone: 'warn' })
  }
  blocks.push(...verificationFailureBlocks(o.verifications ?? []))
  const notes = operationNotes(o)
  if (notes.length > 0)
    blocks.push({ kind: 'text', lines: notes, tone: o.state === 'succeeded' ? 'muted' : 'warn' })
  return blocks
}

type Run = NonNullable<Operation['verifications']>[number]
type RunFailure = NonNullable<Run['structural']['failures']>[number]

/** How many failing expectations the human output lists per run (the JSON has up to 200). */
const FAILURES_LISTED = 20

/**
 * What a verification run found failing (Part A follow-up 3, F2): one line
 * per run that did not pass or excused something, then its failing
 * expectations, the open ones first, excused ones marked.
 */
export function verificationFailureBlocks(
  runs: readonly Pick<
    Run,
    'verificationId' | 'migrationId' | 'status' | 'structural' | 'runtime' | 'engine'
  >[],
): Block[] {
  const blocks: Block[] = []
  for (const v of runs) {
    const layers = [v.structural, v.runtime, v.engine]
    const failures: RunFailure[] = layers.flatMap((l) => l.failures ?? [])
    const total = layers.reduce((n, l) => n + (l.failuresTotal ?? l.failures?.length ?? 0), 0)
    const excused = v.structural.excused ?? 0
    const through = v.engine.acceptedThrough
    if (v.status === 'passed' && excused === 0 && through === undefined) continue
    const engineFailure = v.engine.firstFailure
    const counts = [
      `structural ${v.structural.failed} of ${v.structural.checks} failed`,
      ...(excused > 0 ? [`${excused} excused by review decisions`] : []),
      ...(v.engine.status === 'failed'
        ? [
            `engine: ${engineFailure?.name ?? 'failed'}${engineFailure?.detail == null ? '' : ` (${engineFailure.detail})`}`,
          ]
        : []),
      ...(through === undefined
        ? []
        : [
            `schema accepted as the verified state of ${through.last} (${through.migrations} migration${through.migrations === 1 ? '' : 's'} after the baseline)`,
          ]),
      ...(v.runtime.failed > 0 ? [`runtime ${v.runtime.failed} failed`] : []),
    ]
    blocks.push({
      kind: 'text',
      lines: [
        `Verification ${v.verificationId} of ${v.migrationId}: ${v.status} (${counts.join(', ')})`,
      ],
      tone: v.status === 'passed' ? 'muted' : 'warn',
    })
    if (failures.length === 0) {
      const first = layers.find((l) => l.firstFailure !== null)?.firstFailure
      if (v.status !== 'passed' && first !== undefined && first !== null) {
        blocks.push({
          kind: 'text',
          lines: [
            `First failure: ${first.name}${first.detail === null ? '' : ` (${first.detail})`}`,
          ],
          tone: 'warn',
        })
      }
      continue
    }
    blocks.push({
      kind: 'table',
      columns: [
        { title: 'FILE', flexible: true },
        { title: 'STATEMENT', align: 'right' },
        { title: 'EXPECTED', flexible: true },
        { title: 'DIFFERS' },
        { title: 'EXCUSED' },
      ],
      rows: failures
        .slice(0, FAILURES_LISTED)
        .map((f) => [
          dash(f.file),
          f.statement === null ? '-' : String(f.statement),
          f.object,
          f.failed.join(', '),
          f.excused ? 'yes' : 'no',
        ]),
    })
    if (total > FAILURES_LISTED) {
      blocks.push({
        kind: 'text',
        lines: [
          `${total - FAILURES_LISTED} more failing expectations; --json lists the first ${Math.min(total, 200)}.`,
        ],
        tone: 'muted',
      })
    }
  }
  return blocks
}

/** Plain statements of what happened (never "completed" for a failed verification). */
function operationNotes(o: Operation): string[] {
  if (o.state === 'verification_failed') {
    return o.applyOutcome === 'partially_applied'
      ? ['The migration stopped part-way. Nothing was rolled back; nothing runs again by itself.']
      : ['The change was committed but its verification failed. No rollback was executed.']
  }
  if (o.state === 'failed' && o.applyOutcome === 'not_applied')
    return ['Nothing was applied (rolled back or refused).']
  if (o.state === 'needs_attention')
    return o.applyOutcome === 'applied' || o.applyOutcome === 'partially_applied'
      ? [
          'The change was applied; its verification did not finish. Nothing runs again by itself: verify again once the cause is gone.',
        ]
      : ['The outcome needs a person: nothing runs again by itself.']
  return []
}

/** What to run next for an operation, from the server's next action. */
export function operationNext(o: Operation): string[] {
  const inspect = `exponetdb operation show ${o.id}`
  switch (o.nextAction) {
    case 'approve':
      return [`exponetdb approval open ${o.id}`, `exponetdb operation watch ${o.id}`]
    case 'wait':
      return [`exponetdb operation watch ${o.id}`]
    case 'inspect':
      // An applied change whose verification errored or never finished can be verified again.
      return o.state === 'needs_attention' &&
        (o.applyOutcome === 'applied' || o.applyOutcome === 'partially_applied') &&
        (o.verificationOutcome === 'error' || o.verificationOutcome === 'pending')
        ? [inspect, `exponetdb operation retry-verification ${o.id}`]
        : [inspect]
    case 'resume':
      return [
        o.subject.targetId === null
          ? inspect
          : `exponetdb migration resume ${o.migrations?.find((m) => m.applyOutcome === 'partially_applied')?.migrationId ?? '<migration>'} --target ${o.subject.targetId}`,
        inspect,
      ]
    case 'forward_fix':
      return ['Review the failing check and create a forward-fix migration and plan.', inspect]
    case 'replan':
      return ['Fix the cause, then plan again.', inspect]
    default:
      return []
  }
}
