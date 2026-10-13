import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { type EventOutcome, EventRow } from '../../src/records/event-row.tsx'
import { type LinkComponentProps, LinkProvider } from '../../src/seams/index.ts'
import { axeViolations } from '../support/axe.ts'
import { containsInvisible } from '../support/untrusted.ts'

afterEach(cleanup)

const NOW = '2026-10-13T14:07:30Z'
const OCCURRED = '2026-10-13T14:03:00Z'

function RouterLink({ href, children, ...rest }: LinkComponentProps): React.ReactNode {
  return (
    <a href={href} data-router="yes" {...rest}>
      {children}
    </a>
  )
}

function row(extra: Partial<React.ComponentProps<typeof EventRow>> = {}) {
  return (
    <EventRow
      actor="human #3"
      client="Some MCP client"
      action="migrations.apply"
      subject="acme/platform/staging"
      outcome="succeeded"
      occurredAt={OCCURRED}
      now={NOW}
      {...extra}
    />
  )
}

describe('EventRow', () => {
  it('shows actor, client, action, subject, outcome and time', () => {
    const { container } = render(row())

    expect(container).toHaveTextContent('human #3')
    expect(container).toHaveTextContent('via')
    expect(container).toHaveTextContent('Some MCP client')
    expect(screen.getByText('migrations.apply').tagName).toBe('CODE')
    expect(container).toHaveTextContent('acme/platform/staging')
    expect(container).toHaveTextContent('Succeeded')
    const time = container.querySelector('time')
    expect(time).toHaveAttribute('datetime', '2026-10-13T14:03:00.000Z')
    expect(time).toHaveTextContent('4 min ago (2026-10-13 14:03 UTC)')
  })

  it('marks the client name as not verified, and only the client', () => {
    render(row())

    expect(screen.getAllByText('name not verified')).toHaveLength(1)
  })

  it('leaves out the client and the subject when there are none', () => {
    const { container } = render(row({ client: undefined, subject: undefined }))

    expect(container).not.toHaveTextContent('via')
    expect(container).not.toHaveTextContent(' on ')
    expect(screen.queryByText('name not verified')).toBeNull()
  })

  it('shows actor, client and subject as untrusted text', () => {
    const { container } = render(
      row({
        actor: 'a\u{202E}b',
        client: '<img src=x onerror=alert(1)>',
        subject: 'p\u{200D}q',
      }),
    )

    expect(screen.getByText('⟨U+202E⟩')).toBeInTheDocument()
    expect(screen.getByText('⟨U+200D⟩')).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
    expect(containsInvisible(container.textContent ?? '')).toBe(false)
  })

  it.each<[EventOutcome, string]>([
    ['succeeded', 'Succeeded'],
    ['failed', 'Failed'],
    ['denied', 'Denied'],
    ['pending', 'Pending'],
  ])('shows the outcome %s as a word and an icon', (outcome, label) => {
    const { container } = render(row({ outcome }))

    expect(container).toHaveTextContent(label)
    expect(container.querySelector('[data-outcome]')).toHaveAttribute('data-outcome', outcome)
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  it('shows an outcome it does not know by its name, never an empty badge', () => {
    render(
      row({ outcome: 'canceled' as unknown as React.ComponentProps<typeof EventRow>['outcome'] }),
    )

    expect(screen.getByText('canceled')).toBeInTheDocument()
  })

  it('shows the stable error code of a failed outcome', () => {
    render(row({ outcome: 'failed', errorCode: 'PLAN_STALE' }))

    expect(screen.getByText('PLAN_STALE')).toBeInTheDocument()
  })

  it('links the plan, the operation and the ledger through the link seam', () => {
    render(
      <LinkProvider component={RouterLink}>
        {row({
          links: {
            plan: '/changes/plans/pln_1',
            operation: '/changes/operations/op_1',
            ledger: '/t/acme/platform/staging/migrations#ledger',
          },
        })}
      </LinkProvider>,
    )

    const plan = screen.getByRole('link', { name: 'View plan' })
    expect(plan).toHaveAttribute('href', '/changes/plans/pln_1')
    expect(plan).toHaveAttribute('data-router', 'yes')
    expect(screen.getByRole('link', { name: 'View operation' })).toHaveAttribute(
      'href',
      '/changes/operations/op_1',
    )
    expect(screen.getByRole('link', { name: 'View ledger entry' })).toHaveAttribute(
      'href',
      '/t/acme/platform/staging/migrations#ledger',
    )
  })

  it('renders no link for a target that is not an app path', () => {
    render(
      row({
        links: {
          plan: 'javascript:alert(1)',
          operation: '//evil.example/op',
          ledger: 'https://evil.example/ledger',
        },
      }),
    )

    expect(screen.queryByRole('link')).toBeNull()
  })

  it('keeps the valid links when another one is refused', () => {
    render(row({ links: { plan: '/changes/plans/pln_1', operation: 'https://evil.example' } }))

    expect(screen.getAllByRole('link')).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'View plan' })).toBeInTheDocument()
  })

  it('renders as a list item inside a list when asked', () => {
    render(<ul>{row({ as: 'li' })}</ul>)

    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(1)
  })

  it('has no accessibility violations', async () => {
    const { container } = render(
      <ul>
        {row({
          as: 'li',
          outcome: 'failed',
          errorCode: 'PLAN_STALE',
          links: { plan: '/changes/plans/pln_1' },
        })}
      </ul>,
    )

    expect(await axeViolations(container)).toEqual([])
  })
})
