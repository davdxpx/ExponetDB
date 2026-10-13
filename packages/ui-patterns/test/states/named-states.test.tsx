import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { type LinkComponentProps, LinkProvider } from '../../src/seams/index.ts'
import { LoadingState } from '../../src/states/loading-state.tsx'
import { NotAvailableYetState } from '../../src/states/not-available-yet-state.tsx'
import { NotPermittedState } from '../../src/states/not-permitted-state.tsx'
import { NotSupportedState } from '../../src/states/not-supported-state.tsx'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

function RouterLink({ href, children, ...rest }: LinkComponentProps): React.ReactNode {
  return (
    <a href={href} data-router="yes" {...rest}>
      {children}
    </a>
  )
}

describe('LoadingState', () => {
  it('announces what is loading', () => {
    render(<LoadingState what="schema" />)

    expect(screen.getByRole('status')).toHaveTextContent('Loading schema')
  })

  it('draws the number of skeleton lines asked for, within bounds', () => {
    const { container, rerender } = render(<LoadingState what="schema" lines={5} />)
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(5)

    rerender(<LoadingState what="schema" lines={0} />)
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1)

    rerender(<LoadingState what="schema" lines={500} />)
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(12)
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<LoadingState what="schema" />)

    expect(await axeViolations(container)).toEqual([])
  })
})

describe('NotSupportedState', () => {
  it('names the feature, what it needs and what the target has', () => {
    render(
      <NotSupportedState
        feature="Logical replication slots"
        requires="PostgreSQL 15 or later"
        found="PostgreSQL 14.9"
      />,
    )

    expect(
      screen.getByRole('heading', { name: 'Not supported on this target' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Logical replication slots needs PostgreSQL 15 or later.'),
    ).toBeInTheDocument()
    expect(screen.getByText(/This target has/)).toHaveTextContent('PostgreSQL 14.9')
  })

  it('shows what the target reported as untrusted text', () => {
    const { container } = render(
      <NotSupportedState feature="Slots" requires="PostgreSQL 15" found={'14.9\u{202E}<b>x</b>'} />,
    )

    expect(screen.getByText('⟨U+202E⟩')).toBeInTheDocument()
    expect(container.querySelector('b')).toBeNull()
  })

  it('is neither an alert nor an empty state', () => {
    const { container } = render(<NotSupportedState feature="Slots" requires="PostgreSQL 15" />)

    expect(screen.queryByRole('alert')).toBeNull()
    expect(container.querySelector('[data-slot="empty-state"]')).toBeNull()
    expect(screen.queryByText('Nothing to show')).toBeNull()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(
      <NotSupportedState feature="Slots" requires="PostgreSQL 15" found="PostgreSQL 14.9" />,
    )

    expect(await axeViolations(container)).toEqual([])
  })
})

describe('NotPermittedState', () => {
  it('names the missing permission', () => {
    render(<NotPermittedState what="backup inventory" permission="backups.read" />)

    expect(
      screen.getByRole('heading', { name: 'You do not have access to backup inventory' }),
    ).toBeInTheDocument()
    expect(screen.getByText('backups.read')).toBeInTheDocument()
    expect(screen.getByText(/Missing permission/)).toBeInTheDocument()
    expect(screen.queryByText(/Missing scope/)).toBeNull()
  })

  it('names the missing scope', () => {
    render(<NotPermittedState what="production data" scope="data.read:prod" />)

    expect(screen.getByText('data.read:prod')).toBeInTheDocument()
    expect(screen.getByText(/Missing scope/)).toBeInTheDocument()
    expect(screen.queryByText(/Missing permission/)).toBeNull()
  })

  it('names both when both are given', () => {
    render(<NotPermittedState what="x" permission="a.b" scope="a.b:prod" />)

    expect(screen.getByText('a.b')).toBeInTheDocument()
    expect(screen.getByText('a.b:prod')).toBeInTheDocument()
  })

  it('does not compile without a permission or a scope', () => {
    // @ts-expect-error a denied state must say what is missing
    const element = <NotPermittedState what="x" />
    expect(element).toBeDefined()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<NotPermittedState what="x" permission="a.b" scope="a.b:prod" />)

    expect(await axeViolations(container)).toEqual([])
  })
})

describe('NotAvailableYetState', () => {
  it('reads as a named state: a heading and the reason', () => {
    render(<NotAvailableYetState what="Backups" reason="Backups arrive with Wave 9." />)

    expect(
      screen.getByRole('heading', { level: 3, name: 'Backups is not available yet' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Backups arrive with Wave 9.')).toBeInTheDocument()
  })

  it('is not an error, an empty list or a control that looks usable', () => {
    const { container } = render(
      <NotAvailableYetState
        what="Break-glass activation"
        reason="Break-glass activation needs a notification channel (OD-21)."
      />,
    )

    expect(screen.queryByRole('alert')).toBeNull()
    expect(container.querySelector('[data-slot="empty-state"]')).toBeNull()
    expect(screen.queryByText(/Nothing to show/)).toBeNull()
    expect(screen.queryByText(/^No /)).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('uses the heading level it is given', () => {
    render(<NotAvailableYetState what="Backups" reason="Later." headingLevel={2} />)

    expect(screen.getByRole('heading', { level: 2 })).toBeInTheDocument()
  })

  it('links the document through the link seam', () => {
    render(
      <LinkProvider component={RouterLink}>
        <NotAvailableYetState
          what="Backups"
          reason="Backups arrive with Wave 9."
          docHref="/docs/waves/9"
          docLabel="Read the Wave 9 plan"
        />
      </LinkProvider>,
    )

    const link = screen.getByRole('link', { name: 'Read the Wave 9 plan' })
    expect(link).toHaveAttribute('href', '/docs/waves/9')
    expect(link).toHaveAttribute('data-router', 'yes')
  })

  it('links with a plain anchor and a default label without a provider', () => {
    render(<NotAvailableYetState what="Backups" reason="Later." docHref="/docs/waves/9" />)

    expect(screen.getByRole('link', { name: 'Read more' })).toHaveAttribute('href', '/docs/waves/9')
  })

  it.each(['https://evil.example/x', '//evil.example/x', 'javascript:alert(1)', 'relative/path'])(
    'does not link %s, which is not an app path',
    (docHref) => {
      render(<NotAvailableYetState what="Backups" reason="Later." docHref={docHref} />)

      expect(screen.queryByRole('link')).toBeNull()
    },
  )

  it('shows the reason as text', () => {
    const { container } = render(<NotAvailableYetState what="Backups" reason="<b>soon</b>" />)

    expect(container.querySelector('b')).toBeNull()
    expect(screen.getByText('<b>soon</b>')).toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(
      <NotAvailableYetState
        what="Backups"
        reason="Backups arrive with Wave 9."
        docHref="/docs/x"
      />,
    )

    expect(await axeViolations(container)).toEqual([])
  })
})
