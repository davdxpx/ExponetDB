import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { PageNav } from '../../src/page-nav/index.tsx'
import { type LinkComponentProps, LinkProvider } from '../../src/seams/index.ts'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

const items = [
  { label: 'Overview', href: '/t/acme/platform/staging', active: false },
  { label: 'Migrations', href: '/t/acme/platform/staging/migrations', active: true },
  { label: 'Locks', href: '/t/acme/platform/staging/locks', active: false },
] as const

describe('PageNav', () => {
  it('is a named navigation landmark with a list of links, not a menu widget', () => {
    const { container } = render(<PageNav label="Target sections" items={items} />)

    const nav = screen.getByRole('navigation', { name: 'Target sections' })
    expect(within(nav).getAllByRole('listitem')).toHaveLength(3)
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual([
      '/t/acme/platform/staging',
      '/t/acme/platform/staging/migrations',
      '/t/acme/platform/staging/locks',
    ])
    expect(container.querySelector('[role="menu"], [role="menuitem"]')).toBeNull()
  })

  it('marks only the current page with aria-current', () => {
    render(<PageNav label="Target sections" items={items} />)

    expect(screen.getByRole('link', { name: 'Migrations' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('link', { name: 'Locks' })).not.toHaveAttribute('aria-current')
  })

  it('renders the links through the link seam', () => {
    function RouterLink({ href, children, ...rest }: LinkComponentProps) {
      return (
        <a href={href} data-router="yes" {...rest}>
          {children}
        </a>
      )
    }
    render(
      <LinkProvider component={RouterLink}>
        <PageNav label="Target sections" items={items} />
      </LinkProvider>,
    )

    for (const link of screen.getAllByRole('link'))
      expect(link).toHaveAttribute('data-router', 'yes')
  })

  it('moves between the links with Tab', async () => {
    const user = userEvent.setup()
    render(<PageNav label="Target sections" items={items} />)

    await user.tab()
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('link', { name: 'Migrations' })).toHaveFocus()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<PageNav label="Target sections" items={items} />)

    expect(await axeViolations(container)).toEqual([])
  })

  it('scrolls inside its own row on a narrow screen and brings the current link into view', () => {
    const { container } = render(<PageNav label="Target sections" items={items} />)
    const row = container.querySelector<HTMLElement>('[data-slot="page-nav-menu"]')
    expect(row?.className).toContain('overflow-x-auto')
    expect(row?.className).toContain('[&>nav]:min-w-max')

    // jsdom has no layout: give the row and the current link boxes, then render again.
    cleanup()
    const box = (left: number, right: number) => () =>
      ({ left, right, top: 0, bottom: 0, width: right - left, height: 0, x: left, y: 0 }) as DOMRect
    const original = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.getAttribute('data-slot') === 'page-nav-menu') return box(0, 390)()
      if (this.getAttribute('aria-current') === 'page') return box(500, 600)()
      return original.call(this)
    }
    try {
      const view = render(<PageNav label="Target sections" items={items} />)
      const scroller = view.container.querySelector<HTMLElement>('[data-slot="page-nav-menu"]')
      expect(scroller?.scrollLeft).toBe(210)
    } finally {
      Element.prototype.getBoundingClientRect = original
    }
  })
})
