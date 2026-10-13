// Derived from supabase/supabase packages/ui/src/components/NavMenu/nav-menu.test.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'
import { describe, expect, it } from 'vitest'

import { NavMenu, NavMenuItem } from '../src/nav-menu.tsx'
import { axeViolations } from './support/axe.ts'

describe('NavMenu Component', () => {
  it('renders without crashing', () => {
    render(<NavMenu aria-label="Project" />)
    expect(screen.getByRole('navigation', { name: 'Project' })).toBeInTheDocument()
  })

  it('applies custom className', () => {
    const className = 'test-class'
    render(<NavMenu aria-label="Project" className={className} />)
    expect(screen.getByRole('navigation')).toHaveClass(className)
  })

  it('forwards ref', () => {
    const ref = React.createRef<HTMLElement>()

    render(
      <NavMenu aria-label="Project" ref={ref}>
        test
      </NavMenu>,
    )
    expect(ref.current).toBeInTheDocument()
    expect(ref.current).toBe(screen.getByRole('navigation'))
  })

  it('renders children', () => {
    render(
      <NavMenu aria-label="Project">
        <NavMenuItem active={false}>
          <span>Home</span>
        </NavMenuItem>
      </NavMenu>,
    )
    expect(screen.getByText('Home')).toBeInTheDocument()
  })

  it('is navigation, not a menu widget', async () => {
    const { container } = render(
      <NavMenu aria-label="Project">
        <NavMenuItem active href="/overview">
          Overview
        </NavMenuItem>
        <NavMenuItem active={false} href="/migrations">
          Migrations
        </NavMenuItem>
      </NavMenu>,
    )

    expect(container.querySelector('[role="menu"]')).toBeNull()
    expect(container.querySelector('[role="menuitem"]')).toBeNull()
    expect(screen.getByRole('list')).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(await axeViolations()).toEqual([])
  })

  it('marks the current page link with aria-current and no other', () => {
    render(
      <NavMenu aria-label="Project">
        <NavMenuItem active href="/overview">
          Overview
        </NavMenuItem>
        <NavMenuItem active={false} href="/migrations">
          Migrations
        </NavMenuItem>
      </NavMenu>,
    )

    const current = screen.getByRole('link', { name: 'Overview' })
    expect(current).toHaveAttribute('href', '/overview')
    expect(current).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Migrations' })).not.toHaveAttribute('aria-current')
    expect(current.closest('li')).toHaveAttribute('data-state', 'active')
  })

  it('renders the link through the link component it is given, without a router', () => {
    const calls: Record<string, unknown>[] = []
    const RouterLink = ({
      href,
      children,
      ...rest
    }: { href: string; children?: React.ReactNode } & Record<string, unknown>) => {
      calls.push({ href, ...rest })
      return (
        <a href={href} data-router="true" {...rest}>
          {children}
        </a>
      )
    }

    render(
      <NavMenu aria-label="Project">
        <NavMenuItem active href="/overview" linkComponent={RouterLink}>
          Overview
        </NavMenuItem>
      </NavMenu>,
    )

    const link = screen.getByRole('link', { name: 'Overview' })
    expect(link).toHaveAttribute('data-router', 'true')
    expect(link).toHaveAttribute('aria-current', 'page')
    expect(calls).toHaveLength(1)
  })

  it('merges the current page state into a link element it is given (asChild)', () => {
    render(
      <NavMenu aria-label="Project">
        <NavMenuItem active asChild>
          <a href="/overview">Overview</a>
        </NavMenuItem>
        <NavMenuItem active={false} asChild>
          <a href="/migrations">Migrations</a>
        </NavMenuItem>
      </NavMenu>,
    )

    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Migrations' })).not.toHaveAttribute('aria-current')
  })

  it('renders the label as text, not as markup', () => {
    render(
      <NavMenu aria-label="Project">
        <NavMenuItem active={false} href="/x">
          {'<img src=x onerror=alert(1)>'}
        </NavMenuItem>
      </NavMenu>,
    )

    expect(screen.getByRole('link').textContent).toBe('<img src=x onerror=alert(1)>')
    expect(document.querySelector('img')).toBeNull()
  })
})
