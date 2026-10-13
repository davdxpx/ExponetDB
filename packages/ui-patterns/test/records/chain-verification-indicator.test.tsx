import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Readable } from '../../src/readable.ts'
import {
  type ChainVerification,
  ChainVerificationIndicator,
} from '../../src/records/chain-verification-indicator.tsx'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

const NOW = '2026-10-13T14:07:30Z'

function ready(value: ChainVerification): Readable<ChainVerification> {
  return { state: 'ready', value, source: 'live', observedAt: NOW }
}

describe('ChainVerificationIndicator', () => {
  it('says "verified up to sequence N" with the time, announced politely', () => {
    render(
      <ChainVerificationIndicator
        verification={ready({
          status: 'verified',
          throughSequence: 1204,
          verifiedAt: '2026-10-13T14:03:00Z',
        })}
        now={NOW}
      />,
    )

    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Chain verified up to sequence 1,204')
    expect(status).toHaveTextContent('4 min ago (2026-10-13 14:03 UTC)')
    expect(status.querySelector('svg[data-status="success"]')).not.toBeNull()
  })

  it('says "broken at sequence N" and announces it at once', () => {
    render(
      <ChainVerificationIndicator
        verification={ready({
          status: 'broken',
          atSequence: 1205,
          checkedAt: '2026-10-13T14:03:00Z',
        })}
        now={NOW}
      />,
    )

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Chain broken at sequence 1,205')
    expect(alert).toHaveTextContent(', checked 4 min ago')
    expect(alert.querySelector('svg[data-status="destructive"]')).not.toBeNull()
  })

  it('says a broken chain without a check time', () => {
    render(
      <ChainVerificationIndicator
        verification={ready({ status: 'broken', atSequence: 7 })}
        now={NOW}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent(/^Chain broken at sequence 7$/)
  })

  it('says "not checked" in words with an icon', () => {
    const { container } = render(
      <ChainVerificationIndicator verification={ready({ status: 'not_checked' })} now={NOW} />,
    )

    expect(screen.getByRole('status')).toHaveTextContent('Chain not checked')
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  it('says it is checking while the read is loading', () => {
    render(<ChainVerificationIndicator verification={{ state: 'loading' }} />)

    expect(screen.getByRole('status')).toHaveTextContent('Checking the audit chain')
  })

  it('says the verification could not be read, and never "not checked" or "verified"', () => {
    render(
      <ChainVerificationIndicator
        verification={{ state: 'failed', error: { code: 'NETWORK', message: 'No answer.' } }}
      />,
    )

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Could not read the chain verification: No answer.')
    expect(alert).toHaveTextContent('NETWORK')
    expect(alert).toHaveTextContent('This does not mean the chain is intact or broken.')
    expect(alert).not.toHaveTextContent('Chain not checked')
    expect(alert).not.toHaveTextContent('Chain verified')
  })

  it('marks a stale read as an earlier one', () => {
    render(
      <ChainVerificationIndicator
        verification={{
          state: 'stale',
          value: { status: 'verified', throughSequence: 10, verifiedAt: '2026-10-13T13:00:00Z' },
          source: 'cached',
          observedAt: '2026-10-13T13:00:00Z',
        }}
        now={NOW}
      />,
    )

    expect(screen.getByRole('status')).toHaveTextContent(
      /^Earlier read, Chain verified up to sequence 10/,
    )
  })

  it('names what a partial read is missing', () => {
    render(
      <ChainVerificationIndicator
        verification={{
          state: 'partial',
          value: { status: 'verified', throughSequence: 10, verifiedAt: '2026-10-13T13:00:00Z' },
          source: 'live',
          observedAt: '2026-10-13T13:00:00Z',
          missing: ['Segment 3 is archived.', 'Segment 4 is archived.'],
        }}
        now={NOW}
      />,
    )

    expect(screen.getByRole('status')).toHaveTextContent(
      'Partial read (Segment 3 is archived.; Segment 4 is archived.)',
    )
  })

  it('treats a state it does not know as unreadable', () => {
    render(
      <ChainVerificationIndicator
        verification={{ state: 'bogus' } as unknown as Readable<ChainVerification>}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('could not be read')
    expect(screen.queryByText('Chain not checked')).toBeNull()
  })

  it('shows an invalid sequence as unknown and an invalid time as unknown', () => {
    render(
      <ChainVerificationIndicator
        verification={ready({
          status: 'verified',
          throughSequence: Number.NaN,
          verifiedAt: 'garbage',
        })}
        now={NOW}
      />,
    )

    expect(screen.getByRole('status')).toHaveTextContent(
      'Chain verified up to sequence unknown, time unknown',
    )
  })

  it('has no accessibility violations in any state', async () => {
    const { container } = render(
      <>
        <ChainVerificationIndicator
          verification={ready({ status: 'verified', throughSequence: 1, verifiedAt: NOW })}
          now={NOW}
        />
        <ChainVerificationIndicator
          verification={ready({ status: 'broken', atSequence: 2 })}
          now={NOW}
        />
        <ChainVerificationIndicator verification={ready({ status: 'not_checked' })} now={NOW} />
        <ChainVerificationIndicator verification={{ state: 'loading' }} />
        <ChainVerificationIndicator
          verification={{ state: 'failed', error: { code: 'X', message: 'y' } }}
        />
      </>,
    )

    expect(await axeViolations(container)).toEqual([])
  })
})
