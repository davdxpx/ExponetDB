import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { PageBreadcrumbs, PageBreadcrumbsActions } from '../../src/page-breadcrumbs/index.tsx'
import { type LinkComponentProps, LinkProvider } from '../../src/seams/index.ts'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

const items = [
  { label: 'Databases', href: '/targets' },
  { label: 'reosa', href: '/targets?product=reosa' },
  { label: 'staging' },
] as const

describe('PageBreadcrumbs', () => {
  it('is a named navigation landmark holding an ordered list', () => {
    render(<PageBreadcrumbs items={items} />)

    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' })
    const list = within(nav).getByRole('list')
    expect(list.tagName).toBe('OL')
    expect(within(list).getAllByRole('listitem')).toHaveLength(3)
  })

  it('links the parents and marks the last item as the current page, not a link', () => {
    render(<PageBreadcrumbs items={items} />)

    expect(screen.getByRole('link', { name: 'Databases' })).toHaveAttribute('href', '/targets')
    expect(screen.getByRole('link', { name: 'reosa' })).toHaveAttribute(
      'href',
      '/targets?product=reosa',
    )
    const current = screen.getByText('staging')
    expect(current).toHaveAttribute('aria-current', 'page')
    expect(screen.getAllByRole('link')).toHaveLength(2)
  })

  it('shows a parent without an address as text', () => {
    render(
      <PageBreadcrumbs
        items={[{ label: 'Infrastructure' }, { label: 'Nodes', href: '/n' }, { label: 'node-1' }]}
      />,
    )

    expect(screen.getByText('Infrastructure')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Infrastructure' })).not.toBeInTheDocument()
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
        <PageBreadcrumbs items={items} />
      </LinkProvider>,
    )

    for (const link of screen.getAllByRole('link'))
      expect(link).toHaveAttribute('data-router', 'yes')
  })

  it('renders names as text, never as markup', () => {
    render(
      <PageBreadcrumbs items={[{ label: 'Databases', href: '/targets' }, { label: '<b>x</b>' }]} />,
    )

    expect(screen.getByText('<b>x</b>')).toBeInTheDocument()
    expect(document.querySelector('b')).toBeNull()
  })

  it('shows the actions in the row and hides the separators from assistive technology', () => {
    const { container } = render(
      <PageBreadcrumbs
        items={items}
        actions={
          <PageBreadcrumbsActions>
            <button type="button">Copy path</button>
          </PageBreadcrumbsActions>
        }
      />,
    )

    expect(screen.getByRole('button', { name: 'Copy path' })).toBeVisible()
    for (const separator of container.querySelectorAll('li[role="presentation"]')) {
      expect(separator).toHaveAttribute('aria-hidden', 'true')
    }
  })

  it('renders no navigation for an empty trail but keeps the actions', () => {
    render(<PageBreadcrumbs items={[]} actions={<button type="button">Copy path</button>} />)

    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy path' })).toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<PageBreadcrumbs items={items} />)

    expect(await axeViolations(container)).toEqual([])
  })
})
