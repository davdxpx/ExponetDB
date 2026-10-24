import '@testing-library/jest-dom/vitest'
import { cleanup, screen } from '@testing-library/react'
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
  it('marks a production plan once: the frame and one sentence, no cue on any block', async () => {
    const { container } = renderPlan(<Page production />)
    const frame = container.querySelector('[data-plan-frame]')
    expect(frame).toHaveAttribute('data-tier', 'production')
    const notices = container.querySelectorAll('[data-production-notice]')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toHaveTextContent('This plan changes production.')
    for (const title of BLOCK_TITLES) {
      const block = blockOf(title)
      // The owner's decision of 2026-10-21: no block repeats the cue beside its heading.
      expect(block.querySelector('[data-production-cue]'), title).toBeNull()
      expect(block.className, title).not.toContain('border-production')
    }
    expect(await axeViolations()).toEqual([])
  })

  it('says the page’s own sentence at the head of the frame', () => {
    const { container } = renderPlan(
      <PlanFrame production notice="This plan has no target tier; it is treated as production.">
        <p>Body</p>
      </PlanFrame>,
    )
    expect(container.querySelector('[data-production-notice]')).toHaveTextContent(
      'This plan has no target tier; it is treated as production.',
    )
    expect(container.querySelector('[data-production-cue]')).toBeNull()
  })

  it('adds no frame and no production sentence to a non-production plan', async () => {
    const { container } = renderPlan(<Page production={false} />)
    const frame = container.querySelector('[data-plan-frame]')
    expect(frame).toHaveAttribute('data-tier', 'nonprod')
    expect(container.querySelector('[data-production-notice]')).toBeNull()
    expect(screen.queryByText(/This plan changes production/)).toBeNull()
    expect(await axeViolations()).toEqual([])
  })

  it('puts the computed facts before the raw text, under their own heading', () => {
    renderPlan(<Page production={false} />)
    const computed = screen.getByRole('heading', { name: 'What ExponetDB computed' })
    const raw = screen.getByRole('heading', { name: 'What the plan runs' })
    expect(computed.compareDocumentPosition(raw) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
