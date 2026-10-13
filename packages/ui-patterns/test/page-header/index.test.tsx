import '@testing-library/jest-dom/vitest'
import { NavMenu, NavMenuItem } from '@exponetdb/ui'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  PageHeader,
  PageHeaderAside,
  PageHeaderDescription,
  PageHeaderIcon,
  PageHeaderMeta,
  PageHeaderNavigationTabs,
  PageHeaderSummary,
  PageHeaderTitle,
} from '../../src/page-header/index.tsx'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

function Header({ cue }: { cue?: React.ReactNode }) {
  return (
    <PageHeader>
      <PageHeaderMeta>
        <PageHeaderIcon>
          <svg data-testid="icon" />
        </PageHeaderIcon>
        <PageHeaderSummary>
          <PageHeaderTitle productionCue={cue}>Plans</PageHeaderTitle>
          <PageHeaderDescription>
            Plans awaiting approval and recent decisions.
          </PageHeaderDescription>
        </PageHeaderSummary>
        <PageHeaderAside>
          <button type="button">Create plan</button>
        </PageHeaderAside>
      </PageHeaderMeta>
      <PageHeaderNavigationTabs>
        <NavMenu aria-label="Plan sections">
          <NavMenuItem active href="/changes/plans">
            Plans
          </NavMenuItem>
          <NavMenuItem active={false} href="/changes/operations">
            Operations
          </NavMenuItem>
        </NavMenu>
      </PageHeaderNavigationTabs>
    </PageHeader>
  )
}

describe('PageHeader', () => {
  it('has the title as the single h1 of the page', () => {
    render(<Header />)

    const headings = screen.getAllByRole('heading')
    expect(headings).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1, name: 'Plans' })).toBeInTheDocument()
  })

  it('shows the description and the actions', () => {
    render(<Header />)

    expect(screen.getByText('Plans awaiting approval and recent decisions.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Create plan' })).toBeVisible()
  })

  it('hides the decorative icon from assistive technology', () => {
    render(<Header />)

    expect(screen.getByTestId('icon').parentElement).toHaveAttribute('aria-hidden', 'true')
  })

  it('holds the sub-navigation as a named landmark with the current page marked', () => {
    render(<Header />)

    const nav = screen.getByRole('navigation', { name: 'Plan sections' })
    expect(within(nav).getByRole('link', { name: 'Plans' })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: 'Operations' })).not.toHaveAttribute(
      'aria-current',
    )
  })

  it('shows the production cue the app gives next to the title, outside the heading', () => {
    render(<Header cue={<span>Production</span>} />)

    const heading = screen.getByRole('heading', { level: 1 })
    const cue = screen.getByText('Production')
    expect(heading).toHaveTextContent(/^Plans$/)
    expect(heading).not.toContainElement(cue)
    expect(cue.parentElement).toHaveAttribute('data-slot', 'page-header-production-cue')
    expect(cue.parentElement?.parentElement).toBe(heading.parentElement)
  })

  it('renders no cue wrapper when the app gives none', () => {
    const { container } = render(<Header />)

    expect(container.querySelector('[data-slot="page-header-production-cue"]')).toBeNull()
    expect(container.querySelector('[data-slot="page-header-heading"]')).toBeNull()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<Header cue={<span>Production</span>} />)

    expect(await axeViolations(container)).toEqual([])
  })
})
