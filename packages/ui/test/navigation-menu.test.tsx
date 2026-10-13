import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
  navigationMenuTriggerStyle,
} from '../src/navigation-menu.tsx'
import { axeViolations } from './support/axe.ts'

function Example() {
  return (
    <NavigationMenu aria-label="Documentation">
      <NavigationMenuList>
        <NavigationMenuItem>
          <NavigationMenuTrigger>Guides</NavigationMenuTrigger>
          <NavigationMenuContent>
            <NavigationMenuLink href="/guides/migrations">Migrations</NavigationMenuLink>
          </NavigationMenuContent>
        </NavigationMenuItem>
        <NavigationMenuItem>
          <NavigationMenuLink className={navigationMenuTriggerStyle()} href="/changelog" active>
            Changelog
          </NavigationMenuLink>
        </NavigationMenuItem>
      </NavigationMenuList>
    </NavigationMenu>
  )
}

describe('NavigationMenu', () => {
  it('is a named navigation landmark with a list of items, not a menu widget', async () => {
    const { container } = render(<Example />)

    expect(screen.getByRole('navigation', { name: 'Documentation' })).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(container.querySelector('[role="menu"]')).toBeNull()
    expect(screen.getByRole('link', { name: 'Changelog' })).toHaveAttribute('aria-current', 'page')
    expect(await axeViolations()).toEqual([])
  })

  it('opens a section from its trigger and exposes the state', async () => {
    const user = userEvent.setup()
    render(<Example />)

    const trigger = screen.getByRole('button', { name: 'Guides' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByRole('link', { name: 'Migrations' })).toHaveAttribute(
      'href',
      '/guides/migrations',
    )
    expect(await axeViolations()).toEqual([])
  })

  it('can be operated with the keyboard', async () => {
    const user = userEvent.setup()
    render(<Example />)

    await user.tab()
    const trigger = screen.getByRole('button', { name: 'Guides' })
    expect(trigger).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('{Escape}')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('hides the decorative chevron of the trigger', () => {
    render(<Example />)

    expect(screen.getByRole('button', { name: 'Guides' }).querySelector('svg')).toHaveAttribute(
      'aria-hidden',
      'true',
    )
  })
})
