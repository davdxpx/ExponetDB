import '@testing-library/jest-dom/vitest'
import { cleanup, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { applyVerifyChecks } from '../../src/plan/apply-verify-indicators.tsx'
import { type PlanCheck, PlanChecklist } from '../../src/plan/plan-checklist.tsx'
import { evidenceCheckState } from '../../src/plan/plan-evidence-block.tsx'
import { axeViolations } from '../support/axe.ts'
import { RLO, renderPlan } from './support.tsx'

afterEach(cleanup)

const CHECKS: readonly PlanCheck[] = [
  { id: 'policy', state: 'passed', title: 'Policy', line: 'Allowed by the policy.' },
  { id: 'approvals', state: 'waiting', title: 'Approvals', line: '0 of 1 approval given.' },
  { id: 'evidence', state: 'blocked', title: 'Evidence', line: 'Missing.' },
  { id: 'expiry', state: 'unknown', title: 'Expiry', line: 'Not known.' },
  {
    id: 'operation',
    state: 'failed',
    title: 'Apply',
    line: 'Could not read the operation.',
    action: <button type="button">Try again</button>,
    children: <p>More about it</p>,
  },
]

function row(id: string): HTMLElement {
  const element = document.querySelector(`[data-check="${id}"]`)
  if (!(element instanceof HTMLElement)) throw new Error(`no ${id} row`)
  return element
}

describe('PlanChecklist', () => {
  it('lists each check with its state as a hook, an icon and words, under its heading', async () => {
    renderPlan(<PlanChecklist title="Before it can run" checks={CHECKS} headingLevel={2} />)
    expect(screen.getByRole('heading', { level: 2, name: 'Before it can run' })).toBeVisible()
    const items = screen.getAllByRole('listitem')
    expect(items.map((item) => item.getAttribute('data-check'))).toEqual([
      'policy',
      'approvals',
      'evidence',
      'expiry',
      'operation',
    ])
    expect(row('policy')).toHaveAttribute('data-check-state', 'passed')
    // The state is in words for assistive technology; the line says it for everyone.
    expect(row('policy')).toHaveTextContent('Policy (Passed)Allowed by the policy.')
    expect(row('approvals')).toHaveTextContent('(Waiting)')
    expect(row('evidence')).toHaveTextContent('(Blocked)')
    expect(row('expiry')).toHaveTextContent('(Not known)')
    // A read that failed is its own state, never "passed" or "not known".
    expect(row('operation')).toHaveTextContent('(Could not be read)')
    expect(within(row('operation')).getByRole('button', { name: 'Try again' })).toBeVisible()
    expect(within(row('operation')).getByText('More about it')).toBeVisible()
    expect(await axeViolations()).toEqual([])
  })

  it('carries the extra hooks of a row', () => {
    renderPlan(
      <PlanChecklist
        title="Checks"
        checks={[
          {
            id: 'apply',
            state: 'neutral',
            title: 'Apply',
            line: 'Applied',
            data: { 'data-indicator': 'apply', 'data-outcome': 'applied' },
          },
        ]}
      />,
    )
    expect(row('apply')).toHaveAttribute('data-indicator', 'apply')
    expect(row('apply')).toHaveAttribute('data-outcome', 'applied')
    expect(row('apply')).toHaveTextContent('(No verdict yet)')
  })
})

describe('applyVerifyChecks', () => {
  it('keeps apply and verification apart: applied has no verdict, only a passed check passes', () => {
    const [apply, verification] = applyVerifyChecks({
      applyOutcome: 'applied',
      verificationOutcome: 'pending',
      operationState: 'verifying',
    })
    expect(apply).toMatchObject({ id: 'apply', state: 'neutral' })
    expect(apply.data).toMatchObject({ 'data-indicator': 'apply', 'data-outcome': 'applied' })
    // The verification runs: it waits, it has not passed.
    expect(verification).toMatchObject({ id: 'verification', state: 'waiting' })
    expect(verification.data).toMatchObject({ 'data-outcome': 'running' })
    const [, passed] = applyVerifyChecks({ applyOutcome: 'applied', verificationOutcome: 'passed' })
    expect(passed.state).toBe('passed')
  })

  it('says not known for a missing or unknown outcome, and blocks a failed one', () => {
    const [apply, verification] = applyVerifyChecks({
      applyOutcome: null,
      verificationOutcome: 'failed',
    })
    expect(apply.state).toBe('unknown')
    expect(verification.state).toBe('blocked')
    const [future] = applyVerifyChecks({
      applyOutcome: `later${RLO}`,
      verificationOutcome: 'pending',
    })
    expect(future.state).toBe('unknown')
    renderPlan(<PlanChecklist title="Checks" checks={[future]} />)
    // An outcome this version does not know is marked text, its hidden characters by code point.
    expect(row('apply').textContent).toContain('⟨U+202E⟩')
    expect(row('apply').textContent).not.toContain(RLO)
  })
})

describe('evidenceCheckState', () => {
  it('passes present evidence only, fails an unreachable read and blocks what is missing', () => {
    expect(evidenceCheckState('present')).toBe('passed')
    expect(evidenceCheckState('not_required')).toBe('passed')
    expect(evidenceCheckState('unreachable')).toBe('failed')
    expect(evidenceCheckState('missing')).toBe('blocked')
    expect(evidenceCheckState('unverified')).toBe('blocked')
    expect(evidenceCheckState('other_verify_digest')).toBe('blocked')
    expect(evidenceCheckState(null)).toBe('unknown')
    expect(evidenceCheckState('unknown')).toBe('unknown')
    expect(evidenceCheckState('toString')).toBe('unknown')
  })
})
