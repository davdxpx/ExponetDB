import '@testing-library/jest-dom/vitest'
import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { PolicyDecisionBlock } from '../../src/plan/policy-decision-block.tsx'
import { axeViolations } from '../support/axe.ts'
import { RLO, renderPlan } from './support.tsx'

afterEach(cleanup)

describe('PolicyDecisionBlock', () => {
  it('shows the decision, the requirements and the rules that did not pass, with their ids', async () => {
    renderPlan(
      <PolicyDecisionBlock
        decision="require"
        requirements={[
          { kind: 'approval', count: 1, permission: 'plans.approve' },
          { kind: 'reauth', withinSeconds: 300 },
          { kind: 'backup', newerThan: 'PT24H' },
          { kind: 'maintenance_window', windowId: 'weekly-sunday' },
          { kind: 'break_glass', rules: ['migrations.staging-evidence'] },
        ]}
        rules={[
          {
            id: 'approval.production-change',
            severity: 'require',
            result: 'fail',
            message: `Production changes need an approval for ${RLO}users.`,
            remediation: 'Ask a person with plans.approve.',
            overridableByBreakGlass: false,
          },
          {
            id: 'migrations.lock-risk',
            severity: 'warn',
            result: 'unknown',
            message: 'The lock risk could not be established.',
          },
        ]}
      />,
    )
    expect(screen.getByText('Allow with requirements')).toBeInTheDocument()
    const requirements = screen.getByRole('list', { name: 'Requirements' })
    expect(requirements).toHaveTextContent('1 approval by a person with plans.approve')
    expect(requirements).toHaveTextContent('A fresh re-authentication within 5 min')
    expect(requirements).toHaveTextContent('A verified backup newer than PT24H')
    expect(requirements).toHaveTextContent('Inside maintenance window weekly-sunday')
    expect(requirements).toHaveTextContent(
      'A break-glass grant for the rules migrations.staging-evidence',
    )
    const rules = screen.getByRole('list', { name: 'Rules that did not pass' })
    expect(rules).toHaveTextContent('approval.production-change')
    expect(rules).toHaveTextContent('failed')
    expect(rules).toHaveTextContent('the rule requires')
    expect(rules).toHaveTextContent('could not be evaluated')
    expect(rules).toHaveTextContent('⟨U+202E⟩')
    expect(rules.textContent).not.toContain(RLO)
    expect(rules).toHaveTextContent('Ask a person with plans.approve.')
    expect(await axeViolations()).toEqual([])
  })

  it('shows a denial as a denial', () => {
    renderPlan(<PolicyDecisionBlock decision="deny" requirements={[]} rules={[]} />)
    expect(screen.getByText('Deny')).toBeInTheDocument()
    expect(
      screen.getByText('The policy denies this plan. It cannot be applied.'),
    ).toBeInTheDocument()
  })

  it('names the rules a break-glass grant overrode', () => {
    renderPlan(
      <PolicyDecisionBlock
        decision="allow"
        requirements={[]}
        rules={[]}
        overriddenRules={['migrations.staging-evidence']}
      />,
    )
    expect(
      screen.getByText('Overridden by break-glass:').closest('[role="note"]'),
    ).toHaveTextContent('migrations.staging-evidence')
  })

  it('says "not known" for a missing decision, requirements or rules', async () => {
    renderPlan(<PolicyDecisionBlock decision={null} requirements={null} rules={null} />)
    expect(screen.getByText(/The decision is/)).toHaveTextContent('not known')
    expect(screen.queryByText('Allow')).toBeNull()
    expect(screen.getAllByText('not known').length).toBeGreaterThanOrEqual(3)
    expect(await axeViolations()).toEqual([])
  })

  it('never fills in a missing requirement value', () => {
    renderPlan(
      <PolicyDecisionBlock
        decision="require"
        requirements={[{ kind: 'approval', count: null }, { kind: 'reauth' }, { kind: 'quorum' }]}
        rules={[]}
      />,
    )
    const requirements = screen.getByRole('list', { name: 'Requirements' })
    expect(requirements).toHaveTextContent('Approvals (how many is not known) by an approver')
    expect(requirements).toHaveTextContent('A fresh re-authentication (within not known)')
    expect(requirements).toHaveTextContent('quorum')
    expect(requirements).toHaveTextContent('not known to this version of the Web App')
  })

  it('shows a decision it does not know by its name', () => {
    renderPlan(<PolicyDecisionBlock decision="maybe" requirements={[]} rules={[]} />)
    expect(screen.getByText('(not a known decision)')).toBeInTheDocument()
    expect(screen.getByText('maybe')).toBeInTheDocument()
  })
})
