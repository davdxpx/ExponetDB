import '@testing-library/jest-dom/vitest'
import { TooltipProvider } from '@exponetdb/ui'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  InnerSideBarEmptyPanel,
  InnerSideBarFilterSearchInput,
  InnerSideBarFilterSortDropdown,
  InnerSideBarFilterSortDropdownItem,
  InnerSideBarFilters,
  InnerSideBarShimmeringLoaders,
  InnerSideBarTitle,
  InnerSideMenu,
  InnerSideMenuCollapsible,
  InnerSideMenuCollapsibleContent,
  InnerSideMenuCollapsibleTrigger,
  InnerSideMenuDataItem,
  InnerSideMenuItem,
  InnerSideMenuItemLoading,
  InnerSideMenuSeparator,
} from '../../src/inner-side-menu/index.tsx'
import { type LinkComponentProps, LinkProvider } from '../../src/seams/index.ts'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

describe('InnerSideMenu', () => {
  it('is a named navigation landmark, not a menu widget', () => {
    const { container } = render(
      <InnerSideMenu aria-label="Schema objects">
        <InnerSideMenuItem href="/schema/tables">Tables</InnerSideMenuItem>
      </InnerSideMenu>,
    )

    expect(screen.getByRole('navigation', { name: 'Schema objects' })).toBeInTheDocument()
    expect(container.querySelector('[role="menu"], [role="menuitem"]')).toBeNull()
  })

  it('renders links through the link seam and marks only the current one', () => {
    function RouterLink({ href, children, ...rest }: LinkComponentProps) {
      return (
        <a href={href} data-router="yes" {...rest}>
          {children}
        </a>
      )
    }
    render(
      <LinkProvider component={RouterLink}>
        <InnerSideMenu aria-label="Schema objects">
          <InnerSideMenuItem href="/schema/tables" isActive>
            Tables
          </InnerSideMenuItem>
          <InnerSideMenuItem href="/schema/views">Views</InnerSideMenuItem>
          <InnerSideMenuDataItem href="/schema/tables/accounts" isActive={false}>
            accounts
          </InnerSideMenuDataItem>
          <InnerSideMenuDataItem href="/schema/tables/plans" isActive>
            plans
          </InnerSideMenuDataItem>
        </InnerSideMenu>
      </LinkProvider>,
    )

    for (const link of screen.getAllByRole('link'))
      expect(link).toHaveAttribute('data-router', 'yes')
    expect(screen.getByRole('link', { name: 'Tables' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'plans' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Views' })).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('link', { name: 'accounts' })).not.toHaveAttribute('aria-current')
  })

  it('treats a data item as not current unless told', () => {
    render(
      <InnerSideMenu aria-label="Schema objects">
        <InnerSideMenuDataItem href="/schema/tables/accounts">accounts</InnerSideMenuDataItem>
      </InnerSideMenu>,
    )

    expect(screen.getByRole('link', { name: 'accounts' })).not.toHaveAttribute('aria-current')
  })

  it('shows object names as text, never as markup', () => {
    render(
      <InnerSideMenu aria-label="Schema objects">
        <InnerSideMenuItem href="/schema/tables/x">
          {'<img src=x onerror=alert(1)>'}
        </InnerSideMenuItem>
      </InnerSideMenu>,
    )

    expect(screen.getByRole('link')).toHaveTextContent('<img src=x onerror=alert(1)>')
    expect(document.querySelector('img')).toBeNull()
  })

  it('opens and closes a group with a titled trigger', async () => {
    const user = userEvent.setup()
    render(
      <InnerSideMenu aria-label="Schema objects">
        <InnerSideMenuCollapsible>
          <InnerSideMenuCollapsibleTrigger title="Tables" />
          <InnerSideMenuCollapsibleContent>
            <InnerSideMenuItem href="/schema/tables/accounts">accounts</InnerSideMenuItem>
          </InnerSideMenuCollapsibleContent>
        </InnerSideMenuCollapsible>
      </InnerSideMenu>,
    )

    const trigger = screen.getByRole('button', { name: 'Tables' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).not.toHaveAttribute('title')
    expect(screen.queryByRole('link', { name: 'accounts' })).not.toBeInTheDocument()

    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('link', { name: 'accounts' })).toBeVisible()
  })

  it('shows a separator and a title', () => {
    render(
      <InnerSideMenu aria-label="Schema objects">
        <InnerSideBarTitle>Tables</InnerSideBarTitle>
        <InnerSideMenuSeparator />
      </InnerSideMenu>,
    )

    expect(screen.getByText('Tables')).toBeVisible()
    expect(screen.getByRole('separator')).toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(
      <InnerSideMenu aria-label="Schema objects">
        <InnerSideBarTitle>Tables</InnerSideBarTitle>
        <InnerSideMenuItem href="/schema/tables" isActive>
          Tables
        </InnerSideMenuItem>
        <InnerSideMenuSeparator />
        <InnerSideMenuDataItem href="/schema/tables/accounts">accounts</InnerSideMenuDataItem>
      </InnerSideMenu>,
    )

    expect(await axeViolations(container)).toEqual([])
  })
})

describe('InnerSideBarFilterSearchInput', () => {
  it('is a text field with an accessible name from its label', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <InnerSideBarFilters>
        <InnerSideBarFilterSearchInput label="Filter objects" name="filter" onChange={onChange} />
      </InnerSideBarFilters>,
    )

    const input = screen.getByRole('textbox', { name: 'Filter objects' })
    await user.type(input, 'acc')

    expect(onChange).toHaveBeenCalledTimes(3)
    expect(input).toHaveValue('acc')
  })

  it('marks the field busy while loading and stays a named field', () => {
    const { rerender } = render(
      <InnerSideBarFilterSearchInput label="Filter objects" name="filter" />,
    )
    expect(screen.getByRole('textbox', { name: 'Filter objects' })).not.toHaveAttribute('aria-busy')

    rerender(<InnerSideBarFilterSearchInput label="Filter objects" name="filter" isLoading />)
    expect(screen.getByRole('textbox', { name: 'Filter objects' })).toHaveAttribute(
      'aria-busy',
      'true',
    )
  })

  it('hides its icons from assistive technology', () => {
    const { container } = render(<InnerSideBarFilterSearchInput label="Filter objects" name="f" />)

    for (const icon of container.querySelectorAll('svg'))
      expect(icon).toHaveAttribute('aria-hidden', 'true')
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<InnerSideBarFilterSearchInput label="Filter objects" name="f" />)

    expect(await axeViolations(container)).toEqual([])
  })
})

describe('InnerSideBarFilterSortDropdown', () => {
  function Sort() {
    const [value, setValue] = useState('name')
    return (
      <TooltipProvider delayDuration={0}>
        <InnerSideBarFilterSearchInput label="Filter objects" name="filter">
          <InnerSideBarFilterSortDropdown value={value} onValueChange={setValue}>
            <InnerSideBarFilterSortDropdownItem value="name">
              Name
            </InnerSideBarFilterSortDropdownItem>
            <InnerSideBarFilterSortDropdownItem value="created">
              Created
            </InnerSideBarFilterSortDropdownItem>
          </InnerSideBarFilterSortDropdown>
        </InnerSideBarFilterSearchInput>
        <output>{value}</output>
      </TooltipProvider>
    )
  }

  it('has a trigger with an accessible name that opens a radio group with the chosen option checked', async () => {
    const user = userEvent.setup()
    render(<Sort />)

    await user.click(screen.getByRole('button', { name: 'Sort by' }))

    expect(screen.getByRole('menuitemradio', { name: 'Name' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByRole('menuitemradio', { name: 'Created' })).toHaveAttribute(
      'aria-checked',
      'false',
    )
  })

  it('reports the chosen option and keeps the field name unchanged', async () => {
    const user = userEvent.setup()
    render(<Sort />)

    await user.click(screen.getByRole('button', { name: 'Sort by' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'Created' }))

    expect(screen.getByRole('status')).toHaveTextContent('created')
    expect(screen.getByRole('textbox', { name: 'Filter objects' })).toBeInTheDocument()
  })
})

describe('placeholders and empty panel', () => {
  it('announces the loading rows as a status', () => {
    render(<InnerSideBarShimmeringLoaders />)

    expect(screen.getByRole('status')).toHaveTextContent('Loading')
  })

  it('hides the loading menu item from assistive technology', () => {
    const { container } = render(<InnerSideMenuItemLoading />)

    expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument()
  })

  it('shows the empty panel text, description and actions', () => {
    render(
      <InnerSideBarEmptyPanel
        title="No tables"
        description="This schema has no tables yet."
        actions={<button type="button">Draft migration</button>}
      />,
    )

    expect(screen.getByText('No tables')).toBeVisible()
    expect(screen.getByText('This schema has no tables yet.')).toBeVisible()
    expect(within(document.body).getByRole('button', { name: 'Draft migration' })).toBeVisible()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(
      <>
        <InnerSideBarShimmeringLoaders />
        <InnerSideBarEmptyPanel title="No tables" description="This schema has no tables yet." />
      </>,
    )

    expect(await axeViolations(container)).toEqual([])
  })
})
