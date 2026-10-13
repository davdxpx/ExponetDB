import '@testing-library/jest-dom/vitest'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PlanBinding } from '../../src/plan/plan-actions.tsx'
import { PlanSummaryBlock } from '../../src/plan/plan-summary-block.tsx'
import { axeViolations } from '../support/axe.ts'
import {
  BEFORE_EXPIRY,
  CREATED_AT,
  EXPIRES_AT,
  HASH,
  PLAN_ID,
  PROD_PATH,
  RLO,
  renderPlan,
  ZWSP,
} from './support.tsx'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

type Props = ComponentProps<typeof PlanSummaryBlock>

const BASE: Props = {
  planId: PLAN_ID,
  planHash: HASH,
  subject: { targetPath: PROD_PATH },
  tier: 'prod',
  kind: 'migration.apply',
  planClass: 'high',
  classifications: ['destructive', 'non_transactional'],
  state: 'active',
  creator: { kind: 'human', identityId: 'idn_01JABCDEFGHJKMNPQRSTVWXYZ0', via: 'mcp' },
  clientName: 'Agent Desk',
  createdAt: CREATED_AT,
  expiresAt: EXPIRES_AT,
  now: BEFORE_EXPIRY,
}

function fact(id: string): HTMLElement {
  const row = document.querySelector(`[data-fact="${id}"]`)
  if (!(row instanceof HTMLElement)) throw new Error(`no fact ${id}`)
  const value = row.querySelector('dd')
  if (!(value instanceof HTMLElement)) throw new Error(`no value for ${id}`)
  return value
}

function applyButton(binding: PlanBinding) {
  return (
    <button type="button" data-hash={binding.planHash}>
      Apply plan
    </button>
  )
}

describe('PlanSummaryBlock', () => {
  it('shows what the server computed, with the production tier and the statement classes', async () => {
    renderPlan(<PlanSummaryBlock {...BASE} />)
    expect(screen.getByRole('heading', { name: 'Summary' })).toBeInTheDocument()
    expect(fact('target')).toHaveTextContent(PROD_PATH)
    expect(within(fact('target')).getByText('Production')).toBeInTheDocument()
    expect(fact('kind')).toHaveTextContent('migration.apply')
    expect(fact('class')).toHaveTextContent('High')
    expect(within(fact('classifications')).getByText('Destructive')).toBeInTheDocument()
    expect(within(fact('classifications')).getByText('Non-transactional')).toBeInTheDocument()
    expect(fact('state')).toHaveTextContent('Active')
    expect(fact('creator')).toHaveTextContent('Person')
    expect(fact('client')).toHaveTextContent('MCP (an AI agent)')
    expect(fact('created')).toHaveTextContent('2026-10-13 14:00 UTC')
    expect(await axeViolations()).toEqual([])
  })

  it('marks the client name as not verified and shows its hidden characters by code point', () => {
    renderPlan(<PlanSummaryBlock {...BASE} clientName={`Official${RLO}txt.exe${ZWSP} ExponetDB`} />)
    const value = fact('client-name')
    expect(value).toHaveTextContent('name not verified')
    expect(value).toHaveTextContent('⟨U+202E⟩')
    expect(value).toHaveTextContent('⟨U+200B⟩')
    expect(value.textContent).not.toContain(RLO)
    expect(value.textContent).not.toContain(ZWSP)
  })

  it('shows the full plan hash and copies exactly that value', async () => {
    const user = userEvent.setup()
    renderPlan(<PlanSummaryBlock {...BASE} />)
    const code = fact('plan-hash').querySelector('code')
    expect(code?.textContent).toBe(HASH)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await user.click(screen.getByRole('button', { name: 'Copy plan hash' }))
    await waitFor(() => expect(screen.getByText('Plan hash copied.')).toBeInTheDocument())
    expect(await navigator.clipboard.readText()).toBe(HASH)
  })

  it('says when the clipboard refused and never claims a copy', async () => {
    const user = userEvent.setup()
    renderPlan(<PlanSummaryBlock {...BASE} />)
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    await user.click(screen.getByRole('button', { name: 'Copy plan hash' }))
    await waitFor(() =>
      expect(screen.getByText(/Could not copy the plan hash/)).toBeInTheDocument(),
    )
    expect(screen.queryByText('Plan hash copied.')).toBeNull()
  })

  it('counts down to the expiry and hands the actions the hash it shows', () => {
    const render = vi.fn(applyButton)
    renderPlan(<PlanSummaryBlock {...BASE} renderActions={render} />)
    expect(fact('expires')).toHaveTextContent('Expires in 4 min 30 s')
    expect(fact('expires')).toHaveTextContent('2026-10-13 14:15 UTC')
    expect(screen.getByRole('button', { name: 'Apply plan' })).toHaveAttribute('data-hash', HASH)
    expect(render).toHaveBeenCalledWith({ planId: PLAN_ID, planHash: HASH })
  })

  it('shows an expired plan as expired and does not offer its actions', () => {
    const render = vi.fn(applyButton)
    renderPlan(<PlanSummaryBlock {...BASE} now={EXPIRES_AT} renderActions={render} />)
    expect(fact('expires')).toHaveTextContent('Expired')
    expect(screen.queryByRole('button', { name: 'Apply plan' })).toBeNull()
    expect(render).not.toHaveBeenCalled()
    expect(screen.getByText(/This plan expired\. Create a new plan/)).toBeInTheDocument()
    expect(screen.getByText('This plan expired.')).toBeInTheDocument()
  })

  it('runs a live countdown on the device clock and withdraws the actions at the expiry', () => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    vi.setSystemTime(new Date('2026-10-13T14:14:58.000Z'))
    const { now: _ignored, ...live } = BASE
    renderPlan(<PlanSummaryBlock {...live} renderActions={applyButton} />)
    expect(fact('expires')).toHaveTextContent('Expires in 2 s')
    expect(screen.getByRole('button', { name: 'Apply plan' })).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(fact('expires')).toHaveTextContent('Expires in 1 s')
    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(fact('expires')).toHaveTextContent('Expired')
    expect(screen.queryByRole('button', { name: 'Apply plan' })).toBeNull()
    expect(screen.getByText('This plan expired.')).toBeInTheDocument()
  })

  it.each([
    ['consumed', /accepted/],
    ['invalidated', /stale/],
    ['denied', /denied/],
    ['withdrawn', /withdrawn/],
  ])('does not offer the actions of a %s plan', (state, reason) => {
    renderPlan(<PlanSummaryBlock {...BASE} state={state} renderActions={applyButton} />)
    expect(screen.queryByRole('button', { name: 'Apply plan' })).toBeNull()
    expect(screen.getByText(reason)).toBeInTheDocument()
  })

  it('does not offer the actions from a read that may be out of date', () => {
    renderPlan(<PlanSummaryBlock {...BASE} stale renderActions={applyButton} />)
    expect(screen.queryByRole('button', { name: 'Apply plan' })).toBeNull()
    expect(screen.getByText(/may be out of date/)).toBeInTheDocument()
  })

  it('says "not known" for every missing value and offers nothing', async () => {
    renderPlan(
      <PlanSummaryBlock
        planId={PLAN_ID}
        planHash={HASH}
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
        now={BEFORE_EXPIRY}
        renderActions={applyButton}
      />,
    )
    for (const id of [
      'target',
      'kind',
      'class',
      'classifications',
      'state',
      'creator',
      'client',
      'client-name',
      'expires',
    ]) {
      expect(fact(id)).toHaveTextContent('not known')
    }
    expect(fact('created')).toHaveTextContent('time not known')
    expect(fact('target')).not.toHaveTextContent('Production')
    expect(fact('target')).not.toHaveTextContent('Non-production')
    expect(screen.queryByRole('button', { name: 'Apply plan' })).toBeNull()
    expect(screen.getByText(/state of this plan is not known/)).toBeInTheDocument()
    expect(await axeViolations()).toEqual([])
  })

  it('does not offer the actions when the expiry is not a date', () => {
    renderPlan(<PlanSummaryBlock {...BASE} expiresAt="soon" renderActions={applyButton} />)
    expect(fact('expires')).toHaveTextContent('not known')
    expect(screen.queryByRole('button', { name: 'Apply plan' })).toBeNull()
  })

  it('shows a class or a statement class it does not know by its name, never as a known one', () => {
    renderPlan(<PlanSummaryBlock {...BASE} planClass="medium" classifications={['vacuum_full']} />)
    expect(fact('class')).toHaveTextContent('medium (not a known class)')
    expect(fact('classifications')).toHaveTextContent('vacuum_full (not a known statement class)')
  })

  it('says "none found" for an analysis that found no statement class', () => {
    renderPlan(<PlanSummaryBlock {...BASE} classifications={[]} />)
    expect(fact('classifications')).toHaveTextContent('None found by the analysis')
  })

  it('shows a non-production tier without the production chip', () => {
    renderPlan(
      <PlanSummaryBlock
        {...BASE}
        tier="nonprod"
        subject={{ targetPath: 'shop/platform/staging' }}
      />,
    )
    expect(fact('target')).toHaveTextContent('Non-production')
    expect(within(fact('target')).queryByText('Production')).toBeNull()
  })

  it('offers nothing for an empty plan hash and says the hash is not known', () => {
    const render = vi.fn(applyButton)
    renderPlan(<PlanSummaryBlock {...BASE} planHash=" " renderActions={render} />)
    expect(fact('plan-hash')).toHaveTextContent('not known')
    expect(screen.queryByRole('button', { name: 'Copy plan hash' })).toBeNull()
    expect(render).not.toHaveBeenCalled()
    expect(
      screen.getByText('The plan hash is not known, so no action is offered.'),
    ).toBeInTheDocument()
  })

  it('names a tier outside the contract as unknown instead of a neutral tier', () => {
    renderPlan(<PlanSummaryBlock {...BASE} tier="PROD" />)
    expect(fact('target')).toHaveTextContent('PROD (not a known tier)')
    expect(fact('target')).not.toHaveTextContent('Non-production')
  })
})
