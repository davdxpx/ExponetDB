// Derived from supabase/supabase packages/ui-patterns/src/Admonition/Admonition.test.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  Admonition,
  type AdmonitionProps,
  AdmonitionTypeIcon,
  InfoIcon,
  SuccessIcon,
  WarningIcon,
} from '../../src/admonition/index.tsx'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

const stringDescriptionProps = {
  description: 'Description-only copy.',
} satisfies AdmonitionProps

const invalidLabelProps = {
  // @ts-expect-error label was removed; use title instead.
  label: 'Legacy heading',
  description: 'Body copy.',
} satisfies AdmonitionProps

void stringDescriptionProps
void invalidLabelProps

describe('Admonition', () => {
  it('renders description-only content as a polite status', () => {
    render(<Admonition type="default" description="Changes can take a few minutes to apply." />)

    const note = screen.getByRole('status')
    expect(note).toHaveTextContent('Changes can take a few minutes to apply.')
    expect(note).toHaveAttribute('data-slot', 'alert')
  })

  it('renders children-only content', () => {
    render(
      <Admonition type="info">
        <p>
          Read <a href="/changes/plans">the plans page</a> first.
        </p>
        <ul>
          <li>Keep privileges scoped.</li>
        </ul>
      </Admonition>,
    )

    const note = screen.getByRole('status')
    expect(within(note).getByRole('link', { name: 'the plans page' })).toHaveAttribute(
      'href',
      '/changes/plans',
    )
    expect(within(note).getByText('Keep privileges scoped.')).toBeVisible()
  })

  it('renders a title and a description without a heading', () => {
    render(
      <Admonition
        type="warning"
        title="Manual approval required"
        description="Review the pending changes before continuing."
      />,
    )

    const note = screen.getByRole('status')
    expect(note).toHaveTextContent('Manual approval required')
    expect(note.querySelector('h1, h2, h3, h4, h5, h6')).not.toBeInTheDocument()
    expect(note).toHaveTextContent('Review the pending changes before continuing.')
  })

  it('renders the title via AlertTitle (paragraph, not a heading)', () => {
    render(<Admonition title="Manual approval required" description="Body copy." />)

    const title = within(screen.getByRole('status')).getByText('Manual approval required')
    expect(title.tagName).toBe('P')
    expect(title).toHaveAttribute('data-slot', 'alert-title')
  })

  it('wraps free content in AlertDescription', () => {
    render(
      <Admonition>
        <p>Children body copy.</p>
      </Admonition>,
    )

    const paragraph = within(screen.getByRole('status')).getByText('Children body copy.')
    expect(paragraph.tagName).toBe('P')
    expect(paragraph.parentElement).toHaveAttribute('data-slot', 'alert-description')
  })

  it('announces a destructive admonition at once', () => {
    render(
      <Admonition
        type="destructive"
        title="Deletion blocked"
        description="Resolve dependent targets before retrying."
      />,
    )

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Deletion blocked')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it.each([
    ['default', 'Information'],
    ['info', 'Information'],
    ['success', 'Success'],
    ['warning', 'Warning'],
    ['destructive', 'Error'],
  ] as const)(
    'shows an icon for %s that is named %s, so color is not the only signal',
    (type, name) => {
      render(<Admonition type={type} description="Body copy." />)

      const role = type === 'destructive' ? 'alert' : 'status'
      expect(within(screen.getByRole(role)).getByRole('img', { name })).toBeInTheDocument()
    },
  )

  it('gives each type its own icon shape', () => {
    const shapes = new Set<string>()
    for (const type of ['info', 'success', 'warning', 'destructive'] as const) {
      const { container, unmount } = render(<AdmonitionTypeIcon type={type} />)
      shapes.add(container.querySelector('path')?.getAttribute('d') ?? '')
      unmount()
    }
    expect(shapes.size).toBe(4)
  })

  it('omits the icon when showIcon is false', () => {
    render(
      <Admonition
        type="destructive"
        showIcon={false}
        title="Deletion blocked"
        description="Resolve dependent targets before retrying."
      />,
    )

    const note = screen.getByRole('alert')
    expect(note.querySelector('svg')).not.toBeInTheDocument()
    expect(note).toHaveTextContent('Deletion blocked')
  })

  it('shows the icon given instead of the icon of the type', () => {
    render(<Admonition icon={<span data-testid="own-icon">!</span>} description="Body copy." />)

    expect(screen.getByTestId('own-icon')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('renders the actions next to the text', () => {
    render(
      <Admonition
        type="warning"
        title="Plan expires soon"
        description="Apply it before it expires."
        layout="horizontal"
        actions={<button type="button">Open plan</button>}
      />,
    )

    expect(
      within(screen.getByRole('status')).getByRole('button', { name: 'Open plan' }),
    ).toBeVisible()
  })

  it('renders title and description as text, never as markup', () => {
    render(<Admonition title="<b>bold</b> **x**" description="<img src=x onerror=alert(1)>" />)

    const note = screen.getByRole('status')
    expect(note).toHaveTextContent('<b>bold</b> **x**')
    expect(note).toHaveTextContent('<img src=x onerror=alert(1)>')
    expect(note.querySelector('b, strong, img')).not.toBeInTheDocument()
  })

  it('forwards the ref and the class name to the alert', () => {
    render(<Admonition className="extra" description="Body copy." data-testid="adm" />)

    expect(screen.getByTestId('adm')).toHaveClass('extra')
  })

  it('exposes the bare icons as decorative glyphs', () => {
    const { container } = render(
      <>
        <InfoIcon />
        <SuccessIcon />
        <WarningIcon />
      </>,
    )

    const icons = container.querySelectorAll('svg')
    expect(icons).toHaveLength(3)
    for (const icon of icons) expect(icon).toHaveAttribute('aria-hidden', 'true')
  })

  it('has no accessibility violations', async () => {
    const { container } = render(
      <>
        <Admonition type="info" title="Heads up" description="Body copy." />
        <Admonition type="destructive" title="Blocked" description="Body copy." />
      </>,
    )

    expect(await axeViolations(container)).toEqual([])
  })
})
