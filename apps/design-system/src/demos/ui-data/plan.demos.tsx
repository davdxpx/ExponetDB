import { Button } from '@exponetdb/ui'
import {
  type AnalysisOverallView,
  ApplyVerifyIndicators,
  type ApprovalBinding,
  ApprovalsBlock,
  ComputedFactsSection,
  type MigrationAnalysisView,
  PlanAnalysisBlock,
  type PlanBinding,
  PlanEvidenceBlock,
  PlanFrame,
  type PlanStep,
  PlanStepsBlock,
  PlanSummaryBlock,
  PolicyDecisionBlock,
  type RawPlanFile,
  RawPlanTextBlock,
} from '@exponetdb/ui-data'
import { PlanConfirmDialog } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import type { DemoDefinition } from '../types.ts'
import { minutesAgo, minutesAhead, NOW } from '../ui-patterns/clock.ts'

const PLAN_ID = 'pln_01JABCDEFGHJKMNPQRSTVWXYZ0'
const OPERATION_ID = 'op_01JABCDEFGHJKMNPQRSTVWXYZ0'
const HASH = `sha256:${'5c8d'.repeat(16)}`
const FINGERPRINT = `fp1:${'a1b2'.repeat(16)}`
const M1 = '01JAAAAAAAAAAAAAAAAAAAAAAA'
const M2 = '01JBBBBBBBBBBBBBBBBBBBBBBB'
const PATH = 'shop/platform/production'

const STEPS: readonly PlanStep[] = [
  {
    key: M1,
    label: 'Apply migration',
    name: 'add_placed_at',
    reference: M1,
    detail: 'In one transaction',
    state: 'pending',
  },
  {
    key: M2,
    label: 'Apply migration',
    name: 'index_orders_customer',
    reference: M2,
    detail: 'Not in a transaction; runs alone',
    state: 'pending',
  },
  { key: 'verify', label: 'Verify', detail: 'Runs verify.sql of each migration', state: 'pending' },
]

const OVERALL: AnalysisOverallView = {
  compatibility: 'potentially_breaking',
  lockSeverity: 'medium',
  destructive: true,
  nontransactional: true,
}

const ANALYSIS: readonly MigrationAnalysisView[] = [
  {
    migrationId: M1,
    name: 'add_placed_at',
    compatibility: { declared: 'additive', observed: 'additive', disagree: false },
    lockSeverity: 'low',
    statements: [
      {
        index: 0,
        line: 1,
        kind: 'ALTER TABLE',
        lock: { mode: 'ACCESS EXCLUSIVE', severity: 'low' },
        compatibility: 'additive',
        rewrite: 'none',
        transactional: true,
        coverage: 'derived',
      },
    ],
    drops: [],
    rewrites: [],
    rollback: { available: true, declaredSafety: 'safe' },
    checksum: `sha256:c1:${'0f3a'.repeat(16)}`,
  },
  {
    migrationId: M2,
    name: 'index_orders_customer',
    compatibility: { declared: 'additive', observed: 'potentially_breaking', disagree: true },
    lockSeverity: 'medium',
    statements: [
      {
        index: 0,
        line: 1,
        kind: 'CREATE INDEX CONCURRENTLY',
        lock: { mode: 'SHARE UPDATE EXCLUSIVE', severity: 'medium' },
        compatibility: 'additive',
        rewrite: 'none',
        transactional: false,
        coverage: 'derived',
      },
      {
        index: 1,
        line: 3,
        kind: 'DROP TABLE',
        lock: { mode: 'ACCESS EXCLUSIVE', severity: 'high' },
        compatibility: 'destructive',
        rewrite: 'none',
        transactional: true,
        coverage: 'derived',
      },
    ],
    drops: ['public.orders_archive'],
    rewrites: [{ relation: 'public.orders', rows: 1_200_000, bytes: 880_000_000 }],
    rollback: { available: false },
    checksum: `sha256:c1:${'7e21'.repeat(16)}`,
  },
]

const FILES: readonly RawPlanFile[] = [
  {
    migrationId: M1,
    file: 'up.sql',
    revision: 1,
    bytes: 58,
    truncated: false,
    lines: [
      {
        text: 'alter table orders add column placed_at timestamptz;',
        statement: {
          index: 0,
          kind: 'ALTER TABLE',
          lock: 'ACCESS EXCLUSIVE',
          compatibility: 'additive',
          destructive: false,
        },
      },
    ],
  },
  {
    migrationId: M2,
    file: 'up.sql',
    revision: 3,
    bytes: 150,
    truncated: false,
    lines: [
      {
        text: 'create index concurrently orders_customer_idx on orders (customer_id);',
        statement: {
          index: 0,
          kind: 'CREATE INDEX CONCURRENTLY',
          lock: 'SHARE UPDATE EXCLUSIVE',
          compatibility: 'additive',
          destructive: false,
        },
      },
      { text: '-- cleanup \u{05D0} + 99' },
      {
        text: 'drop table orders_archive\u{202E};',
        statement: {
          index: 1,
          kind: 'DROP TABLE',
          lock: 'ACCESS EXCLUSIVE',
          compatibility: 'destructive',
          destructive: true,
        },
      },
    ],
  },
]

function ApplyActions({ binding }: { binding: PlanBinding }): ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <PlanConfirmDialog
        trigger={
          <Button type="button" variant="primary">
            Apply to production
          </Button>
        }
        title={`Apply this plan to ${PATH}?`}
        description="The plan runs as shown. If the target changed since the plan was made, the apply stops and nothing runs."
        actionLabel="Apply to production"
        plan={{ planHash: binding.planHash, tier: 'prod', planClass: 'high', targetPath: PATH }}
        onConfirm={() => Promise.resolve()}
      />
      <Button type="button" variant="outline">
        Withdraw plan
      </Button>
    </div>
  )
}

function DecisionActions({ binding }: { binding: ApprovalBinding }): ReactNode {
  return (
    <>
      <Button type="button" variant="primary" data-plan-hash={binding.planHash}>
        Approve plan
      </Button>
      <Button type="button" variant="outline">
        Reject plan
      </Button>
    </>
  )
}

function Summary({
  state = 'active',
  expiresAt = minutesAhead(10),
  withActions = true,
  production = true,
}: {
  state?: string
  expiresAt?: string
  withActions?: boolean
  production?: boolean
}): ReactNode {
  return (
    <PlanSummaryBlock
      planId={PLAN_ID}
      planHash={HASH}
      subject={{ targetPath: production ? PATH : 'shop/platform/staging' }}
      tier={production ? 'prod' : 'nonprod'}
      kind="migration.apply"
      planClass={production ? 'high' : 'standard'}
      classifications={['destructive', 'non_transactional']}
      state={state}
      creator={{ kind: 'service', identityId: 'idn_01JABCDEFGHJKMNPQRSTVWXYZ1', via: 'mcp' }}
      clientName="Coding assistant"
      createdAt={minutesAgo(5)}
      expiresAt={expiresAt}
      now={NOW}
      headingLevel={3}
      renderActions={withActions ? (binding) => <ApplyActions binding={binding} /> : undefined}
    />
  )
}

function ProductionPlanPage(): ReactNode {
  return (
    <PlanFrame production>
      <ComputedFactsSection headingLevel={3}>
        <Summary />
        <PlanStepsBlock steps={STEPS} headingLevel={4} />
        <PlanAnalysisBlock overall={OVERALL} migrations={ANALYSIS} headingLevel={4} />
        <PlanEvidenceBlock
          evidence="present"
          evidenceEnvironment="shop/platform/staging"
          items={[
            { migrationId: M1, status: 'present', verifiedAt: minutesAgo(180) },
            { migrationId: M2, status: 'present', verifiedAt: minutesAgo(175) },
          ]}
          schemaFingerprint={FINGERPRINT}
          newestBackup={null}
          now={NOW}
          headingLevel={4}
        />
        <PolicyDecisionBlock
          decision="require"
          requirements={[
            { kind: 'approval', count: 1, permission: 'plans.approve' },
            { kind: 'reauth', withinSeconds: 300 },
          ]}
          rules={[
            {
              id: 'prod.destructive.requires-approval',
              severity: 'require',
              result: 'fail',
              message: 'A plan that drops an object on production needs an approval.',
              remediation: 'Ask a person with plans.approve to approve the plan.',
              overridableByBreakGlass: false,
            },
          ]}
          headingLevel={4}
        />
        <ApprovalsBlock
          planId={PLAN_ID}
          planHash={HASH}
          operationId={OPERATION_ID}
          required={1}
          given={0}
          approvals={[]}
          eligibility={{ canApprove: true, selfApproval: false }}
          proposedByAgent
          now={NOW}
          renderApproveActions={(binding) => <DecisionActions binding={binding} />}
          headingLevel={4}
        />
        <ApplyVerifyIndicators
          applyOutcome="not_started"
          verificationOutcome="pending"
          now={NOW}
          headingLevel={4}
        />
      </ComputedFactsSection>
      <RawPlanTextBlock files={FILES} omitted={0} runs={2} headingLevel={3} />
    </PlanFrame>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui-data/plan-frame/production-page',
    title:
      'A production plan: the frame, every block with its production cue, the server facts first and the raw text last',
    render: () => <ProductionPlanPage />,
  },
  {
    id: 'ui-data/plan-frame/nonproduction',
    title: 'A non-production plan: no frame and no production cue on any block',
    render: () => (
      <PlanFrame production={false}>
        <Summary production={false} withActions={false} />
        <PlanStepsBlock steps={STEPS.slice(0, 1)} headingLevel={3} />
      </PlanFrame>
    ),
  },
  {
    id: 'ui-data/plan-summary/active',
    title: 'Summary of an active plan: a countdown and the actions of the plan',
    render: () => (
      <PlanFrame production>
        <Summary />
      </PlanFrame>
    ),
  },
  {
    id: 'ui-data/plan-summary/expired',
    title: 'Summary of an expired plan: "Expired", and no action is offered',
    render: () => (
      <PlanFrame production>
        <Summary state="active" expiresAt={minutesAgo(2)} />
      </PlanFrame>
    ),
  },
  {
    id: 'ui-data/plan-summary/unknown-values',
    title:
      'Summary with values the server did not give: each reads "not known", never a favorable default',
    render: () => (
      <PlanFrame production>
        <PlanSummaryBlock
          planId={PLAN_ID}
          planHash=""
          subject={{ targetPath: null }}
          tier={null}
          kind={null}
          planClass={null}
          classifications={null}
          state={null}
          creator={null}
          clientName={null}
          createdAt={null}
          expiresAt={null}
          now={NOW}
          headingLevel={3}
        />
      </PlanFrame>
    ),
  },
  {
    id: 'ui-data/plan-steps/pending',
    title: 'Steps in the order the plan runs them, with the foreign names marked',
    render: () => <PlanStepsBlock steps={STEPS} headingLevel={3} />,
  },
  {
    id: 'ui-data/plan-steps/not-known',
    title: 'Steps that are not known are said to be not known, not shown as an empty list',
    render: () => <PlanStepsBlock steps={null} headingLevel={3} />,
  },
  {
    id: 'ui-data/plan-analysis/migrations',
    title:
      'Analysis: the overall result, then each migration with its statements, locks, drops and rewrites',
    render: () => <PlanAnalysisBlock overall={OVERALL} migrations={ANALYSIS} headingLevel={3} />,
  },
  {
    id: 'ui-data/plan-evidence/present',
    title:
      'Evidence from the evidence environment, per migration, and the bound schema fingerprint',
    render: () => (
      <PlanEvidenceBlock
        evidence="present"
        evidenceEnvironment="shop/platform/staging"
        items={[
          { migrationId: M1, status: 'present', verifiedAt: minutesAgo(180) },
          { migrationId: M2, status: 'unverified', verifiedAt: null },
        ]}
        schemaFingerprint={FINGERPRINT}
        newestBackup={null}
        now={NOW}
        headingLevel={3}
      />
    ),
  },
  {
    id: 'ui-data/plan-evidence/break-glass',
    title: 'Evidence missing, and a plan made under a break-glass grant',
    render: () => (
      <PlanEvidenceBlock
        evidence="missing"
        evidenceEnvironment="shop/platform/staging"
        breakGlass={{
          grantId: 'bgr_01JABCDEFGHJKMNPQRSTVWXYZ2',
          rules: ['prod.requires-staging-evidence'],
        }}
        schemaFingerprint={FINGERPRINT}
        newestBackup={{ at: minutesAgo(600), verified: false }}
        now={NOW}
        headingLevel={3}
      />
    ),
  },
  {
    id: 'ui-data/policy-decision/require',
    title: 'Policy decision with requirements, and the rule that did not pass with what to do',
    render: () => (
      <PolicyDecisionBlock
        decision="require"
        requirements={[
          { kind: 'approval', count: 1, permission: 'plans.approve' },
          { kind: 'reauth', withinSeconds: 300 },
          { kind: 'backup', newerThan: 'PT24H' },
        ]}
        rules={[
          {
            id: 'prod.destructive.requires-approval',
            severity: 'require',
            result: 'fail',
            message: 'A plan that drops an object on production needs an approval.',
            remediation: 'Ask a person with plans.approve to approve the plan.',
          },
          {
            id: 'prod.backup.recent',
            severity: 'warn',
            result: 'unknown',
            message: 'No verified backup is known for this target.',
          },
        ]}
        headingLevel={3}
      />
    ),
  },
  {
    id: 'ui-data/policy-decision/deny',
    title: 'A denied plan: the decision and the rule that denied it',
    render: () => (
      <PolicyDecisionBlock
        decision="deny"
        requirements={[]}
        rules={[
          {
            id: 'agent.prod.apply',
            severity: 'deny',
            result: 'fail',
            message: 'An agent cannot apply a plan to production.',
            remediation: 'A person applies the plan after approving it.',
            overridableByBreakGlass: false,
          },
        ]}
        headingLevel={3}
      />
    ),
  },
  {
    id: 'ui-data/approvals/agent-proposed',
    title:
      'Approvals of a plan an agent proposed: the note, the count, and the decision for an eligible person',
    render: () => (
      <ApprovalsBlock
        planId={PLAN_ID}
        planHash={HASH}
        operationId={OPERATION_ID}
        required={1}
        given={0}
        approvals={[]}
        eligibility={{ canApprove: true, selfApproval: false }}
        proposedByAgent
        now={NOW}
        renderApproveActions={(binding) => <DecisionActions binding={binding} />}
        headingLevel={3}
      />
    ),
  },
  {
    id: 'ui-data/approvals/self-approval',
    title:
      'A self-approval needs an acknowledgement, and a cooling-down approval says when the plan can be applied',
    render: () => (
      <ApprovalsBlock
        planId={PLAN_ID}
        planHash={HASH}
        operationId={OPERATION_ID}
        required={2}
        given={1}
        approvals={[
          {
            id: 'apr_1',
            approverIdentityId: 'idn_01JABCDEFGHJKMNPQRSTVWXYZ3',
            approverName: 'Dana',
            decision: 'approved',
            selfApproval: true,
            decidedAt: minutesAgo(3),
            notBefore: minutesAhead(30),
          },
        ]}
        eligibility={{ canApprove: true, selfApproval: true }}
        proposedByAgent={false}
        now={NOW}
        renderApproveActions={(binding) => <DecisionActions binding={binding} />}
        headingLevel={3}
      />
    ),
  },
  {
    id: 'ui-data/approvals/not-eligible',
    title: 'A person who cannot approve sees the reason from the server and no button',
    render: () => (
      <ApprovalsBlock
        planId={PLAN_ID}
        planHash={HASH}
        operationId={OPERATION_ID}
        required={1}
        given={0}
        approvals={[]}
        eligibility={{
          canApprove: false,
          reason: 'You made this plan; another person approves it.',
        }}
        proposedByAgent={false}
        now={NOW}
        renderApproveActions={(binding) => <DecisionActions binding={binding} />}
        headingLevel={3}
      />
    ),
  },
  {
    id: 'ui-data/raw-plan-text/files',
    title:
      'The text the plan runs, line by line, as data, with the server facts before each statement',
    render: () => (
      <RawPlanTextBlock files={FILES} omitted={0} runs={2} collapsedLines={200} headingLevel={3} />
    ),
  },
  {
    id: 'ui-data/apply-verify/applied-pending',
    title: 'Applied and not yet verified: two indicators, and the first is not "done"',
    render: () => (
      <ApplyVerifyIndicators
        applyOutcome="applied"
        appliedAt={minutesAgo(4)}
        verificationOutcome="pending"
        operationState="verifying"
        now={NOW}
        headingLevel={3}
      />
    ),
  },
  {
    id: 'ui-data/apply-verify/verified',
    title: 'Verified: the only state shown as done',
    render: () => (
      <ApplyVerifyIndicators
        applyOutcome="applied"
        appliedAt={minutesAgo(9)}
        verificationOutcome="passed"
        verifiedAt={minutesAgo(8)}
        now={NOW}
        headingLevel={3}
      />
    ),
  },
  {
    id: 'ui-data/apply-verify/needs-attention',
    title:
      'Needs attention: the next action from the server, and "Verify again" only when the server accepts it',
    render: () => (
      <ApplyVerifyIndicators
        applyOutcome="applied"
        appliedAt={minutesAgo(20)}
        verificationOutcome="error"
        verifiedAt={minutesAgo(19)}
        needsAttention={{
          nextAction: 'Verify again once the target answers, or plan a recovery.',
          retryable: true,
        }}
        onVerifyAgain={() => Promise.resolve()}
        now={NOW}
        headingLevel={3}
      />
    ),
  },
]
