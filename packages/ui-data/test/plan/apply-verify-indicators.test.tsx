import '@testing-library/jest-dom/vitest'
import { act, cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApplyVerifyIndicators } from '../../src/plan/apply-verify-indicators.tsx'
import { axeViolations } from '../support/axe.ts'
import { renderPlan } from './support.tsx'

afterEach(cleanup)

const NOW = '2026-10-13T14:30:00.000Z'

function indicator(name: 'apply' | 'verification'): HTMLElement {
  const element = document.querySelector(`[data-indicator="${name}"]`)
  if (!(element instanceof HTMLElement)) throw new Error(`no ${name} indicator`)
  return element
}

describe('ApplyVerifyIndicators', () => {
  it('shows applied and pending verification as two indicators, never as one success', async () => {
    const { container } = renderPlan(
      <ApplyVerifyIndicators
        applyOutcome="applied"
        appliedAt="2026-10-13T14:20:00.000Z"
        verificationOutcome="pending"
        now={NOW}
      />,
    )
    expect(indicator('apply')).toHaveTextContent('Apply')
    expect(indicator('apply')).toHaveTextContent('Applied')
    expect(indicator('apply')).toHaveTextContent('Applied is not verified.')
    expect(indicator('apply')).toHaveTextContent('2026-10-13 14:20 UTC (10 min ago)')
    expect(indicator('apply')).not.toHaveAttribute('data-tone', 'done')
    expect(indicator('verification')).toHaveTextContent('Pending')
    expect(container).not.toHaveTextContent(/succe(ss|eded)/i)
    expect(container).not.toHaveTextContent('Verified')
    expect(container.querySelectorAll('[data-tone="done"]')).toHaveLength(0)
    expect(await axeViolations()).toEqual([])
  })

  it('shows "Verified" only for a passed verification, in its own indicator', () => {
    renderPlan(
      <ApplyVerifyIndicators
        applyOutcome="applied"
        verificationOutcome="passed"
        verifiedAt="2026-10-13T14:25:00.000Z"
        now={NOW}
      />,
    )
    expect(indicator('verification')).toHaveTextContent('Verified')
    expect(indicator('verification')).toHaveAttribute('data-tone', 'done')
    expect(indicator('apply')).toHaveAttribute('data-tone', 'neutral')
  })

  it.each([
    ['not_started', 'Not started'],
    ['pending', 'Pending'],
    ['running', 'Applying'],
    ['applied', 'Applied'],
    ['partially_applied', 'Partially applied'],
    ['not_applied', 'Not applied'],
    ['failed', 'Failed'],
  ])('names the apply outcome %s', (outcome, label) => {
    renderPlan(<ApplyVerifyIndicators applyOutcome={outcome} verificationOutcome="pending" />)
    expect(indicator('apply').querySelector('strong')).toHaveTextContent(label)
    expect(indicator('apply').querySelector('svg')).not.toBeNull()
  })

  it.each([
    ['pending', 'Pending'],
    ['passed', 'Verified'],
    ['verified', 'Verified'],
    ['partial', 'Partly verified'],
    ['failed', 'Verification failed'],
    ['error', 'Verification error'],
    ['not_applicable', 'Not applicable'],
  ])('names the verification outcome %s', (outcome, label) => {
    renderPlan(<ApplyVerifyIndicators applyOutcome="applied" verificationOutcome={outcome} />)
    expect(indicator('verification').querySelector('strong')).toHaveTextContent(label)
  })

  it('says "not known" for outcomes the server could not establish, never success', () => {
    const { container } = renderPlan(
      <ApplyVerifyIndicators
        applyOutcome="unknown"
        appliedAt={null}
        verificationOutcome={null}
        now={NOW}
      />,
    )
    expect(indicator('apply')).toHaveTextContent('Not known')
    expect(indicator('apply')).toHaveTextContent('time not known')
    expect(indicator('verification')).toHaveTextContent('Not known')
    expect(container.querySelectorAll('[data-tone="done"]')).toHaveLength(0)
  })

  it('shows an outcome it does not know by its name', () => {
    renderPlan(<ApplyVerifyIndicators applyOutcome="rolled_back" verificationOutcome="pending" />)
    expect(indicator('apply')).toHaveTextContent('rolled_back')
    expect(indicator('apply')).toHaveAttribute('data-tone', 'unknown')
  })

  it('shows progress from the operation state without inventing an outcome', () => {
    const { rerender } = renderPlan(
      <ApplyVerifyIndicators
        applyOutcome="not_started"
        verificationOutcome="pending"
        operationState="running"
      />,
    )
    expect(indicator('apply')).toHaveTextContent('Applying')
    expect(indicator('verification')).toHaveTextContent('Pending')
    rerender(
      <ApplyVerifyIndicators
        applyOutcome="applied"
        verificationOutcome="pending"
        operationState="verifying"
      />,
    )
    expect(indicator('apply')).toHaveTextContent('Applied')
    expect(indicator('verification')).toHaveTextContent('Verifying')
  })

  it('offers "Verify again" only when the server says the retry is accepted, and runs it once', async () => {
    const user = userEvent.setup()
    let finish: () => void = () => {}
    const onVerifyAgain = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    renderPlan(
      <ApplyVerifyIndicators
        applyOutcome="applied"
        verificationOutcome="error"
        needsAttention={{ nextAction: 'Run the verification again.', retryable: true }}
        onVerifyAgain={onVerifyAgain}
      />,
    )
    expect(screen.getByText('Needs attention')).toBeInTheDocument()
    expect(screen.getByText('Run the verification again.')).toBeInTheDocument()
    const button = screen.getByRole('button', { name: 'Verify again' })
    await user.click(button)
    await user.click(button)
    expect(onVerifyAgain).toHaveBeenCalledTimes(1)
    await act(async () => {
      finish()
    })
    expect(await axeViolations()).toEqual([])
  })

  it('says when "Verify again" did not start', async () => {
    const user = userEvent.setup()
    renderPlan(
      <ApplyVerifyIndicators
        applyOutcome="applied"
        verificationOutcome="error"
        needsAttention={{ nextAction: 'Run the verification again.', retryable: true }}
        onVerifyAgain={() => Promise.reject(new Error('internal detail'))}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Verify again' }))
    expect(await screen.findByText(/Verify again did not start/)).toBeInTheDocument()
    expect(screen.queryByText(/internal detail/)).toBeNull()
  })

  it('does not offer "Verify again" when the retry is refused or not known', () => {
    const onVerifyAgain = vi.fn()
    const { rerender } = renderPlan(
      <ApplyVerifyIndicators
        applyOutcome="partially_applied"
        verificationOutcome="pending"
        needsAttention={{ nextAction: null, retryable: false }}
        onVerifyAgain={onVerifyAgain}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Verify again' })).toBeNull()
    expect(
      screen.getByText('Verification cannot be retried for this operation.'),
    ).toBeInTheDocument()
    expect(screen.getByText(/Inspect the operation/)).toHaveTextContent('not known')
    rerender(
      <ApplyVerifyIndicators
        applyOutcome="partially_applied"
        verificationOutcome="pending"
        needsAttention={{ nextAction: null, retryable: null }}
        onVerifyAgain={onVerifyAgain}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Verify again' })).toBeNull()
    expect(screen.getByText(/Whether verification can be retried is/)).toHaveTextContent(
      'not known',
    )
  })

  it('has no attention box for an operation that does not need attention', () => {
    renderPlan(<ApplyVerifyIndicators applyOutcome="applied" verificationOutcome="passed" />)
    expect(screen.queryByText('Needs attention')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Verify again' })).toBeNull()
  })
})
