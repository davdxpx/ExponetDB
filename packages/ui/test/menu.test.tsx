import '@testing-library/jest-dom/vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { Menu, MenuGroup, MenuItem, menuItemVariants } from '../src/menu.tsx'
import { axeViolations } from './support/axe.ts'

describe('Menu', () => {
  it('is a named navigation landmark holding a list, with no menu roles', async () => {
    const { container } = render(
      <Menu aria-label="Settings">
        <MenuItem href="/settings/general" active>
          General
        </MenuItem>
        <MenuItem href="/settings/access">Access</MenuItem>
      </Menu>,
    )

    expect(screen.getByRole('navigation', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(container.querySelector('[role="menu"]')).toBeNull()
    expect(container.querySelector('[role="menuitem"]')).toBeNull()
    expect(container.querySelector('[aria-orientation]')).toBeNull()
    expect(await axeViolations()).toEqual([])
  })

  it('renders entries as links and marks only the current one', () => {
    render(
      <Menu aria-label="Settings">
        <MenuItem href="/settings/general" active>
          General
        </MenuItem>
        <MenuItem href="/settings/access">Access</MenuItem>
      </Menu>,
    )

    const general = screen.getByRole('link', { name: 'General' })
    expect(general).toHaveAttribute('href', '/settings/general')
    expect(general).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Access' })).not.toHaveAttribute('aria-current')
  })

  it('renders an entry without an address as a button that can be reached and used with the keyboard', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <Menu aria-label="Objects">
        <MenuItem onClick={onClick}>users</MenuItem>
      </Menu>,
    )

    const button = screen.getByRole('button', { name: 'users' })
    expect(button).toHaveAttribute('type', 'button')
    await user.tab()
    expect(button).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('renders the link through the link component it is given, without a router', () => {
    const RouterLink = ({
      href,
      children,
      ...rest
    }: { href: string; children?: ReactNode } & Record<string, unknown>) => (
      <a href={href} data-router="true" {...rest}>
        {children}
      </a>
    )

    render(
      <Menu aria-label="Settings">
        <MenuItem href="/settings/general" linkComponent={RouterLink} active>
          General
        </MenuItem>
      </Menu>,
    )

    const link = screen.getByRole('link', { name: 'General' })
    expect(link).toHaveAttribute('data-router', 'true')
    expect(link).toHaveAttribute('aria-current', 'page')
  })

  it('shows the icon beside the label without making it part of the name twice', () => {
    render(
      <Menu aria-label="Settings">
        <MenuItem href="/x" icon={<svg aria-hidden="true" data-testid="icon" />}>
          General
        </MenuItem>
      </Menu>,
    )

    expect(screen.getByRole('link', { name: 'General' })).toContainElement(
      screen.getByTestId('icon'),
    )
  })

  it('groups entries under a title that names their list', async () => {
    render(
      <Menu aria-label="Settings" type="pills">
        <MenuGroup title="Project" action={<button type="button">Add</button>}>
          <MenuItem href="/a">Alpha</MenuItem>
          <MenuItem href="/b">Beta</MenuItem>
        </MenuGroup>
      </Menu>,
    )

    const group = screen.getByRole('list', { name: 'Project' })
    expect(within(group).getAllByRole('link')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument()
    expect(await axeViolations()).toEqual([])
  })

  it('omits the empty list of a group without entries', () => {
    render(
      <Menu aria-label="Settings">
        <MenuGroup title="Project" />
      </Menu>,
    )

    expect(screen.queryByRole('list', { name: 'Project' })).not.toBeInTheDocument()
    expect(screen.getByText('Project')).toBeInTheDocument()
  })

  it('applies the variants of the chosen type', () => {
    render(
      <Menu aria-label="Settings" type="border">
        <MenuItem href="/a" active>
          Alpha
        </MenuItem>
      </Menu>,
    )

    expect(screen.getByRole('link')).toHaveClass(
      ...menuItemVariants({ type: 'border', active: true }).split(' '),
    )
    expect(screen.getByRole('link')).toHaveClass('focus-ring')
  })
})
