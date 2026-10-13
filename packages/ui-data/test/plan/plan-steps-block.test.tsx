import '@testing-library/jest-dom/vitest'
import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { PlanStepsBlock } from '../../src/plan/plan-steps-block.tsx'
import { axeViolations } from '../support/axe.ts'
import { RLO, renderPlan } from './support.tsx'

afterEach(cleanup)

describe('PlanStepsBlock', () => {
  it('lists the steps in order, numbered, with foreign names marked', async () => {
    renderPlan(
      <PlanStepsBlock
        steps={[
          {
            key: '01JABCDEFGHJKMNPQRSTVWXYZ0',
            label: 'Apply migration',
            name: `create_orders${RLO}`,
            reference: '01JABCDEFGHJKMNPQRSTVWXYZ0',
            detail: 'In one transaction',
            state: 'succeeded',
          },
          {
            key: '01JABCDEFGHJKMNPQRSTVWXYZ1',
            label: 'Apply migration',
            name: 'add_index',
            reference: '01JABCDEFGHJKMNPQRSTVWXYZ1',
            detail: 'Not in a transaction; runs alone',
            state: 'running',
          },
          { key: 'verify', label: 'Verify', state: 'pending' },
        ]}
      />,
    )
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('1.')
    expect(items[0]).toHaveTextContent('Apply migration')
    expect(items[0]).toHaveTextContent('⟨U+202E⟩')
    expect(items[0]?.textContent).not.toContain(RLO)
    expect(items[0]).toHaveTextContent('Succeeded')
    expect(items[1]).toHaveTextContent('2.')
    expect(items[1]).toHaveTextContent('Running')
    expect(items[2]).toHaveTextContent('3.')
    expect(items[2]).toHaveTextContent('Verify')
    expect(items[2]).toHaveTextContent('Pending')
    expect(await axeViolations()).toEqual([])
  })

  it('keeps two steps with the same key apart', () => {
    renderPlan(
      <PlanStepsBlock
        steps={[
          { key: 'same', label: 'First' },
          { key: 'same', label: 'Second' },
        ]}
      />,
    )
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      '1.First',
      '2.Second',
    ])
  })

  it('shows a step state it does not know by its name', () => {
    renderPlan(<PlanStepsBlock steps={[{ key: 'a', label: 'Apply', state: 'paused' }]} />)
    expect(screen.getByRole('listitem')).toHaveTextContent('paused (not a known state)')
  })

  it('says "not known" when the steps are missing', () => {
    renderPlan(<PlanStepsBlock steps={null} />)
    expect(screen.getByText(/The steps of this plan are/)).toHaveTextContent('not known')
  })

  it('says when the server listed no steps', () => {
    renderPlan(<PlanStepsBlock steps={[]} />)
    expect(screen.getByText('The server listed no steps for this plan.')).toBeInTheDocument()
  })
})
