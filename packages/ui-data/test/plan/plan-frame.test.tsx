import '@testing-library/jest-dom/vitest'
import { cleanup, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ApplyVerifyIndicators } from '../../src/plan/apply-verify-indicators.tsx'
import { ApprovalsBlock } from '../../src/plan/approvals-block.tsx'
import { PlanAnalysisBlock } from '../../src/plan/plan-analysis-block.tsx'
import { PlanEvidenceBlock } from '../../src/plan/plan-evidence-block.tsx'
import { ComputedFactsSection, PlanFrame } from '../../src/plan/plan-frame.tsx'
import { PlanStepsBlock } from '../../src/plan/plan-steps-block.tsx'
import { PlanSummaryBlock } from '../../src/plan/plan-summary-block.tsx'
import { PolicyDecisionBlock } from '../../src/plan/policy-decision-block.tsx'
import { RawPlanTextBlock } from '../../src/plan/raw-plan-text-block.tsx'
import { axeViolations } from '../support/axe.ts'
import {
  BEFORE_EXPIRY,
  CREATED_AT,
  EXPIRES_AT,
  HASH,
  PLAN_ID,
  PROD_PATH,
  renderPlan,
} from './support.tsx'

afterEach(cleanup)

function Page({ production }: { readonly production: boolean }) {
  return (
    <PlanFrame production={production}>
      <ComputedFactsSection>
        <PlanSummaryBlock
          planId={PLAN_ID}
          planHash={HASH}
          subject={{ targetPath: PROD_PATH }}
          tier={production ? 'prod' : 'nonprod'}
          kind="migration.apply"
          planClass="high"
          classifications={[]}
          state="active"
          creator={{ kind: 'human', identityId: 'idn_01JABCDEFGHJKMNPQRSTVWXYZ0', via: 'web' }}
          clientName={null}
          createdAt={CREATED_AT}
          expiresAt={EXPIRES_AT}
          now={BEFORE_EXPIRY}
          headingLevel={3}
        />
        <PlanStepsBlock steps={[]} headingLevel={3} />
        <PlanAnalysisBlock overall={null} migrations={[]} headingLevel={3} />
        <PlanEvidenceBlock
          evidence="present"
          schemaFingerprint="fp1:abc"
          newestBackup={null}
          headingLevel={3}
        />
        <PolicyDecisionBlock decision="allow" requirements={[]} rules={[]} headingLevel={3} />
        <ApprovalsBlock
          planId={PLAN_ID}
          planHash={HASH}
          operationId={null}
          required={0}
          given={0}
          approvals={[]}
          eligibility={null}
          proposedByAgent={false}
          headingLevel={3}
        />
        <ApplyVerifyIndicators
          applyOutcome="not_started"
          verificationOutcome="pending"
          headingLevel={3}
        />
      </ComputedFactsSection>
      <RawPlanTextBlock files={[]} omitted={0} runs={0} />
    </PlanFrame>
  )
}

const BLOCK_TITLES = [
  'Summary',
  'Steps',
  'Analysis',
  'Evidence',
  'Policy decision',
  'Approvals',
  'Apply and verification',
  'What the plan runs',
]

function blockOf(title: string): HTMLElement {
  const heading = screen.getByRole('heading', { name: title })
  const section = heading.closest('section')
  if (!(section instanceof HTMLElement)) throw new Error(`no section for ${title}`)
  return section
}

describe('PlanFrame', () => {
  it('frames a production plan and repeats the production cue on every block', async () => {
    const { container } = renderPlan(<Page production />)
    const frame = container.querySelector('[data-plan-frame]')
    expect(frame).toHaveAttribute('data-tier', 'production')
    expect(
      within(frame as HTMLElement).getByText(/This plan changes a production target/),
    ).toBeInTheDocument()
    for (const title of BLOCK_TITLES) {
      const block = blockOf(title)
      // The block's own cue, beside its heading (the summary's tier chip says it as well).
      expect(block.querySelector(':scope > div [data-production-cue]')).not.toBeNull()
    }
    expect(await axeViolations()).toEqual([])
  })

  it('adds no frame and no production cue to a non-production plan', async () => {
    const { container } = renderPlan(<Page production={false} />)
    const frame = container.querySelector('[data-plan-frame]')
    expect(frame).toHaveAttribute('data-tier', 'nonprod')
    expect(container.querySelector('[data-production-cue]')).toBeNull()
    expect(screen.queryByText(/This plan changes a production target/)).toBeNull()
    expect(screen.queryByText('Production')).toBeNull()
    expect(await axeViolations()).toEqual([])
  })

  it('puts the computed facts before the raw text, under their own heading', () => {
    renderPlan(<Page production={false} />)
    const computed = screen.getByRole('heading', { name: 'What ExponetDB computed' })
    const raw = screen.getByRole('heading', { name: 'What the plan runs' })
    expect(computed.compareDocumentPosition(raw) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
