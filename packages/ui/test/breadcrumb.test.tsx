import '@testing-library/jest-dom/vitest'
import { render, screen, within } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it } from 'vitest'

import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '../src/breadcrumb.tsx'
import { axeViolations } from './support/axe.ts'

function Trail() {
  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink href="/targets">Targets</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbEllipsis />
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>acme/prod/main</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  )
}

describe('Breadcrumb', () => {
  it('is a named navigation landmark holding an ordered list', async () => {
    render(<Trail />)

    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' })
    const list = within(nav).getByRole('list')
    expect(list.tagName).toBe('OL')
    expect(within(list).getAllByRole('listitem').length).toBeGreaterThanOrEqual(3)
    expect(await axeViolations()).toEqual([])
  })

  it('marks the current page and links the others', () => {
    render(<Trail />)

    expect(screen.getByRole('link', { name: 'Targets' })).toHaveAttribute('href', '/targets')
    const page = screen.getByText('acme/prod/main')
    expect(page).toHaveAttribute('aria-current', 'page')
    expect(page.tagName).toBe('SPAN')
    expect(screen.getAllByRole('link')).toHaveLength(1)
  })

  it('hides the separators and names the ellipsis', () => {
    const { container } = render(<Trail />)

    for (const separator of container.querySelectorAll('li[role="presentation"]')) {
      expect(separator).toHaveAttribute('aria-hidden', 'true')
    }
    expect(screen.getByText('More')).toHaveClass('sr-only')
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  it('renders the link as the element it is given (asChild), without a router', () => {
    render(
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <button type="button">Targets</button>
            </BreadcrumbLink>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>,
    )

    expect(screen.getByRole('button', { name: 'Targets' })).toHaveClass('hover:text-foreground')
  })

  it('lets the caller rename the landmark and forwards refs', () => {
    const ref = createRef<HTMLElement>()
    render(
      <Breadcrumb aria-label="Location" ref={ref}>
        <BreadcrumbList />
      </Breadcrumb>,
    )

    expect(screen.getByRole('navigation', { name: 'Location' })).toBe(ref.current)
  })

  it('renders names as text', () => {
    render(
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbPage>{'<script>alert(1)</script>'}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>,
    )

    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument()
    expect(document.querySelector('script')).toBeNull()
  })
})
