import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { renderDemo } from './support.tsx'

afterEach(cleanup)

const change = (element: HTMLElement, value: string) =>
  fireEvent.change(element, { target: { value } })
const press = (key: string) =>
  fireEvent.keyDown(document.body, {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
  })

describe('the layout', () => {
  it('draws the four sizes with their limits, and the chrome as named landmarks', async () => {
    const widths = renderDemo('guidance/layout/widths')
    const sizes = within(screen.getByRole('list', { name: 'Page container sizes' })).getAllByRole(
      'listitem',
    )
    expect(sizes.map((item) => item.querySelector('code')?.textContent)).toEqual([
      'small',
      'default',
      'large',
      'full',
    ])
    expect(sizes[0]).toHaveTextContent('768 px')
    expect(sizes[1]).toHaveTextContent('1200 px')
    expect(sizes[2]).toHaveTextContent('1600 px')
    expect(sizes[3]).toHaveTextContent('no limit')
    widths.unmount()

    const { container } = renderDemo('guidance/layout/page-chrome')
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument()
    const sections = screen.getByRole('navigation', { name: 'Target sections' })
    expect(within(sections).getByRole('link', { name: 'Overview' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(sections).getByRole('link', { name: 'Migrations' })).not.toHaveAttribute(
      'aria-current',
    )
    expect(container.querySelector('[role="menu"], [role="menuitem"]')).toBeNull()
    // The last crumb is the current page and not a link.
    expect(
      within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText('staging'),
    ).toHaveAttribute('aria-current', 'page')
    expect(await axeViolations(container)).toEqual([])
  })
})

describe('error handling', () => {
  it('shows catalog text with its code and fixed text for everything else', () => {
    renderDemo('guidance/error-handling/classes')
    const alert = () => screen.getByRole('alert')

    expect(alert()).toHaveTextContent('The plan no longer matches the target. Create a new plan.')
    expect(alert()).toHaveTextContent('PLAN_STALE')

    fireEvent.click(screen.getByRole('radio', { name: 'The server could not be reached' }))
    expect(alert()).toHaveTextContent(
      'The server could not be reached. Check your connection and try again.',
    )
    expect(alert()).toHaveTextContent('NETWORK')
    expect(alert()).not.toHaveTextContent('fetch failed')

    fireEvent.click(screen.getByRole('radio', { name: /Too many requests/ }))
    expect(alert()).toHaveTextContent('Too many attempts. Try again in 30 seconds.')
    expect(alert()).toHaveTextContent('RATE_LIMITED')

    fireEvent.click(screen.getByRole('radio', { name: 'An exception the page did not expect' }))
    expect(alert()).toHaveTextContent('Something went wrong. Reload the page and try again.')
    expect(alert()).toHaveTextContent('UNKNOWN')
    // The exception text is shown to the reader of this page, never in the alert.
    expect(alert()).not.toHaveTextContent('migrator')
    expect(alert()).not.toHaveTextContent('password authentication failed')
  })
})

describe('keyboard shortcuts', () => {
  it('lists every shortcut of the registry by group', () => {
    renderDemo('guidance/keyboard-shortcuts/reference')
    expect(screen.getByRole('heading', { name: 'General' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Go to' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Switch environment' })).toBeInTheDocument()
    expect(screen.getByText('Go to plans')).toBeInTheDocument()
    expect(screen.getByText('Switch to production')).toBeInTheDocument()
    // Screen readers hear words, not letters.
    expect(screen.getByText('G then P')).toBeInTheDocument()
  })

  it('runs a sequence, lists only what works on the page, and switches letters off', async () => {
    renderDemo('guidance/keyboard-shortcuts/try-it')
    press('g')
    press('p')
    expect(screen.getByRole('status')).toHaveTextContent('Shortcut ran: Go to plans.')

    press('?')
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })
    expect(within(dialog).getByText('Go to plans')).toBeInTheDocument()
    expect(within(dialog).getByText('Go to operations')).toBeInTheDocument()
    expect(within(dialog).getByText('Switch to staging')).toBeInTheDocument()
    expect(within(dialog).queryByText('Go to audit')).not.toBeInTheDocument()
    expect(await axeViolations(document.body)).toEqual([])

    // Letters do nothing while a dialog is open, and the switch turns them off for good.
    press('g')
    press('o')
    expect(screen.getByRole('status', { hidden: true })).toHaveTextContent(
      'Shortcut ran: Go to plans.',
    )
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Letter shortcuts' }))
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    press('g')
    press('o')
    expect(screen.getByRole('status')).toHaveTextContent('Shortcut ran: Go to plans.')
  })

  it('ignores letters typed into a field', () => {
    renderDemo('guidance/forms/validation')
    renderDemo('guidance/keyboard-shortcuts/try-it')
    const field = screen.getByRole('textbox', { name: 'Environment name' })
    fireEvent.keyDown(field, { key: 'g', code: 'KeyG', bubbles: true })
    fireEvent.keyDown(field, { key: 'p', code: 'KeyP', bubbles: true })
    expect(screen.getAllByRole('status').every((status) => status.textContent === '')).toBe(true)
  })
})

describe('copywriting', () => {
  it('warns next to the reason field, linked to it, that the text is permanent', async () => {
    const { container } = renderDemo('guidance/copywriting/audit-reason')
    const field = screen.getByRole('textbox', { name: /Reason for rejecting/ })
    expect(field).toHaveAccessibleDescription(
      'This reason is kept permanently in the audit log. Do not enter personal data.',
    )
    expect(field).toHaveAttribute('maxlength', '1000')
    expect(container).toHaveTextContent('0 of 1000')
    change(field, 'Superseded by a smaller plan')
    expect(container).toHaveTextContent('28 of 1000')
    fireEvent.click(screen.getByRole('button', { name: 'Reject plan' }))
    expect(screen.getByRole('status')).toHaveTextContent(
      'Plan rejected. The reason is now part of the audit log.',
    )
    expect(field).toHaveValue('')
    expect(await axeViolations(container)).toEqual([])
  })

  it('words messages by what happened and what to do next, without exclamation marks', () => {
    const { container } = renderDemo('guidance/copywriting/messages')
    expect(container).toHaveTextContent('Resume the target, then create the plan again.')
    expect(container).toHaveTextContent('TARGET_SUSPENDED')
    expect(container).toHaveTextContent('Applied is not verified.')
    expect(container.textContent).not.toContain('!')
  })
})

describe('query conventions', () => {
  it('maps each state of a query to one Readable state', () => {
    renderDemo('guidance/query-conventions/readable-mapping')
    const expected: readonly (readonly [string, string])[] = [
      ['The first read is running', 'loading'],
      ['The first read failed', 'failed'],
      ['Data arrived 20 seconds ago', 'ready'],
      ['Data arrived 5 minutes ago and nothing refreshed it', 'stale'],
      ['Data arrived 40 seconds ago and the refresh failed', 'stale'],
      ['The server marked its answer as incomplete', 'partial'],
    ]
    for (const [label, state] of expected) {
      fireEvent.click(screen.getByRole('radio', { name: label }))
      expect(screen.getByText('Becomes', { exact: false })).toHaveTextContent(`Becomes ${state}`)
    }
  })

  it('never renders a failed first read as an empty list', () => {
    const { container } = renderDemo('guidance/query-conventions/readable-mapping')
    fireEvent.click(screen.getByRole('radio', { name: 'The first read failed' }))
    expect(container).toHaveTextContent('This does not mean there is no target list.')
    expect(container.querySelector('ul')).toBeNull()
  })
})

describe('composition patterns', () => {
  it('builds two cards from the same parts', () => {
    const { container } = renderDemo('guidance/composition-patterns/parts')
    expect(container.querySelectorAll('h3')).toHaveLength(2)
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })

  it('lets the app answer what a pattern asks for', () => {
    const { container } = renderDemo('guidance/composition-patterns/seams')
    const log = screen.getByRole('list', { name: 'What the app received' })
    expect(within(log).queryAllByRole('listitem')).toHaveLength(0)

    fireEvent.click(screen.getByRole('link', { name: 'Open plan pln_01K9D4' }))
    fireEvent.click(screen.getByRole('button', { name: 'Go to plans' }))
    fireEvent.click(screen.getByRole('button', { name: 'Report an event' }))

    expect(
      within(log)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Link: the app opened /changes/plans/pln_01K9D4',
      'Navigate: the app went to /changes/plans',
      'Telemetry: plan.review.opened {"tier":"prod"}',
    ])
    expect(container.querySelector('a')).toHaveAttribute('href', '/changes/plans/pln_01K9D4')
    expect(window.location.pathname).toBe('/')
  })
})

describe('accessibility', () => {
  it('keeps an unavailable action focusable, described and inert', async () => {
    const { container } = renderDemo('guidance/accessibility/unavailable-action')
    const button = screen.getByRole('button', { name: 'Approve plan' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).not.toHaveAttribute('disabled')
    expect(button).toHaveAccessibleDescription(
      'You created this plan. A different person must approve it.',
    )
    button.focus()
    expect(button).toHaveFocus()
    expect(
      (await screen.findAllByText('You created this plan. A different person must approve it.'))
        .length,
    ).toBeGreaterThan(0)
    expect(await axeViolations(container)).toEqual([])
  })

  it('gives each status a shape and a word', () => {
    const { container } = renderDemo('guidance/accessibility/status-shapes')
    expect([...container.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      'Information',
      'Success',
      'Warning',
      'Error',
    ])
    const shapes = [...container.querySelectorAll('svg')].map((svg) => svg.innerHTML)
    expect(new Set(shapes).size).toBe(4)
  })
})
