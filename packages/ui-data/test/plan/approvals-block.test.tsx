import '@testing-library/jest-dom/vitest'
import { cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { type ApprovalBinding, ApprovalsBlock } from '../../src/plan/approvals-block.tsx'
import { axeViolations } from '../support/axe.ts'
import { HASH, OPERATION_ID, OTHER_HASH, PLAN_ID, RLO, renderPlan } from './support.tsx'

afterEach(cleanup)

type Props = ComponentProps<typeof ApprovalsBlock>

const BASE: Props = {
  planId: PLAN_ID,
  planHash: HASH,
  operationId: OPERATION_ID,
  required: 1,
  given: 0,
  approvals: [],
  eligibility: { canApprove: true, selfApproval: false },
  proposedByAgent: false,
  now: '2026-10-13T14:10:00.000Z',
}

function approveButtons(binding: ApprovalBinding) {
  return (
    <>
      <button
        type="button"
        data-hash={binding.planHash}
        data-ack={String(binding.acknowledgedSelfApproval)}
      >
        Approve plan
      </button>
      <button type="button">Reject plan</button>
    </>
  )
}

describe('ApprovalsBlock', () => {
  it('notes that an agent proposed the plan and cannot approve it', async () => {
    renderPlan(<ApprovalsBlock {...BASE} proposedByAgent renderApproveActions={approveButtons} />)
    const note = screen.getByText('An agent proposed this plan; it cannot approve it.')
    expect(note.closest('[role="note"]')).toHaveAttribute('id', `agent-note-${OPERATION_ID}`)
    expect(await axeViolations()).toEqual([])
  })

  it('has no agent note for a plan a person made', () => {
    renderPlan(<ApprovalsBlock {...BASE} />)
    expect(screen.queryByText(/An agent proposed this plan/)).toBeNull()
  })

  it('offers the decision to an eligible person, bound to the full hash it shows', async () => {
    const render = vi.fn(approveButtons)
    renderPlan(<ApprovalsBlock {...BASE} renderApproveActions={render} />)
    expect(screen.getByText('You can approve this plan.')).toBeInTheDocument()
    const shown = document.querySelector('[data-full-hash]')
    expect(shown?.textContent).toBe(HASH)
    expect(screen.getByRole('button', { name: 'Approve plan' })).toHaveAttribute('data-hash', HASH)
    expect(render).toHaveBeenCalledWith({
      planId: PLAN_ID,
      planHash: HASH,
      operationId: OPERATION_ID,
      acknowledgedSelfApproval: false,
    })
    expect(screen.getByText('0 of 1 required approval given')).toBeInTheDocument()
    expect(await axeViolations()).toEqual([])
  })

  it('shows the server answer for a person who cannot approve, and offers nothing', () => {
    renderPlan(
      <ApprovalsBlock
        {...BASE}
        eligibility={{
          canApprove: false,
          reason: 'You made this plan; another person approves it.',
        }}
        renderApproveActions={approveButtons}
      />,
    )
    expect(screen.getByText('You cannot approve this plan.')).toBeInTheDocument()
    expect(screen.getByText('You made this plan; another person approves it.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve plan' })).toBeNull()
  })

  it('offers nothing when the eligibility is not known', () => {
    renderPlan(
      <ApprovalsBlock {...BASE} eligibility={null} renderApproveActions={approveButtons} />,
    )
    expect(screen.getByText(/Whether you can approve this plan is/)).toHaveTextContent('not known')
    expect(screen.queryByRole('button', { name: 'Approve plan' })).toBeNull()
  })

  it('offers nothing from a read that may be out of date, or without a waiting operation', () => {
    const { unmount } = renderPlan(
      <ApprovalsBlock {...BASE} stale renderApproveActions={approveButtons} />,
    )
    expect(screen.queryByRole('button', { name: 'Approve plan' })).toBeNull()
    expect(screen.getByText(/may be out of date/)).toBeInTheDocument()
    unmount()
    renderPlan(
      <ApprovalsBlock {...BASE} operationId={null} renderApproveActions={approveButtons} />,
    )
    expect(screen.queryByRole('button', { name: 'Approve plan' })).toBeNull()
    expect(screen.getByText('No operation is waiting for approval.')).toBeInTheDocument()
  })

  it('asks for an explicit acknowledgement of a self-approval and starts over for another hash', async () => {
    const user = userEvent.setup()
    const { rerender } = renderPlan(
      <ApprovalsBlock
        {...BASE}
        eligibility={{ canApprove: true, selfApproval: true }}
        renderApproveActions={approveButtons}
      />,
    )
    expect(screen.getByText(/approving it is a self-approval/)).toBeInTheDocument()
    const box = screen.getByRole('checkbox', { name: /This is my own plan/ })
    expect(box).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Approve plan' })).toHaveAttribute(
      'data-ack',
      'false',
    )
    await user.click(box)
    expect(box).toBeChecked()
    expect(screen.getByRole('button', { name: 'Approve plan' })).toHaveAttribute('data-ack', 'true')
    expect(await axeViolations()).toEqual([])

    rerender(
      <ApprovalsBlock
        {...BASE}
        planHash={OTHER_HASH}
        eligibility={{ canApprove: true, selfApproval: true }}
        renderApproveActions={approveButtons}
      />,
    )
    expect(screen.getByRole('checkbox', { name: /This is my own plan/ })).not.toBeChecked()
    const approve = screen.getByRole('button', { name: 'Approve plan' })
    expect(approve).toHaveAttribute('data-ack', 'false')
    expect(approve).toHaveAttribute('data-hash', OTHER_HASH)
  })

  it('lists the decisions with self-approvals and the cooling period', () => {
    renderPlan(
      <ApprovalsBlock
        {...BASE}
        required={2}
        given={1}
        approvals={[
          {
            id: 'apr_01',
            approverIdentityId: 'idn_01JABCDEFGHJKMNPQRSTVWXYZ1',
            approverName: `Ada${RLO}`,
            decision: 'approved',
            selfApproval: true,
            decidedAt: '2026-10-13T14:05:00.000Z',
            notBefore: '2026-10-13T14:15:00.000Z',
          },
        ]}
      />,
    )
    expect(screen.getByText('1 of 2 required approvals given')).toBeInTheDocument()
    const list = screen.getByRole('list', { name: 'Decisions' })
    expect(list).toHaveTextContent('Approved')
    expect(list).toHaveTextContent('Self-approval')
    expect(list).toHaveTextContent('⟨U+202E⟩')
    expect(list.textContent).not.toContain(RLO)
    expect(list).toHaveTextContent('The plan can be applied from 2026-10-13 14:15 UTC')
  })

  it('says "not known" for missing counts and decisions', () => {
    renderPlan(<ApprovalsBlock {...BASE} required={null} given={null} approvals={null} />)
    expect(screen.getByText(/The approvals this plan needs are/)).toHaveTextContent('not known')
    expect(screen.getByText(/The decisions so far are/)).toHaveTextContent('not known')
  })

  it('says when a plan needs no approval', () => {
    renderPlan(<ApprovalsBlock {...BASE} required={0} />)
    expect(screen.getByText('This plan needs no approval.')).toBeInTheDocument()
  })

  it('offers no decision for an empty plan hash', () => {
    const render = vi.fn(approveButtons)
    renderPlan(<ApprovalsBlock {...BASE} planHash="" renderApproveActions={render} />)
    expect(render).not.toHaveBeenCalled()
    expect(
      screen.getByText('The plan hash is not known, so no decision is offered.'),
    ).toBeInTheDocument()
  })
})
