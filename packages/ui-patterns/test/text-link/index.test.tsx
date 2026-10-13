import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { type LinkComponentProps, LinkProvider } from '../../src/seams/index.ts'
import { isAppPath, TextLink } from '../../src/text-link/index.tsx'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

describe('isAppPath', () => {
  it('accepts app paths', () => {
    expect(isAppPath('/changes/plans')).toBe(true)
    expect(isAppPath('/approvals#operation=op_1')).toBe(true)
    expect(isAppPath('/')).toBe(true)
  })

  it.each([
    'https://example.com',
    'http://example.com',
    '//example.com',
    '/\\example.com',
    'javascript:alert(1)',
    'mailto:a@b.c',
    'changes/plans',
    '',
  ])('refuses %j', (href) => {
    expect(isAppPath(href)).toBe(false)
  })
})

describe('TextLink', () => {
  it('is a link to the app path, named by its label', () => {
    render(<TextLink href="/changes/plans" label="View plans" />)

    const link = screen.getByRole('link', { name: 'View plans' })
    expect(link).toHaveAttribute('href', '/changes/plans')
  })

  it('opens in the same tab and never sets a target or opener', () => {
    render(<TextLink href="/changes/plans" label="View plans" />)

    const link = screen.getByRole('link')
    expect(link).not.toHaveAttribute('target')
    expect(link).not.toHaveAttribute('rel')
  })

  it('renders through the link seam', () => {
    function RouterLink({ href, children, ...rest }: LinkComponentProps) {
      return (
        <a href={href} data-router="yes" {...rest}>
          {children}
        </a>
      )
    }
    render(
      <LinkProvider component={RouterLink}>
        <TextLink href="/changes/plans" label="View plans" />
      </LinkProvider>,
    )

    expect(screen.getByRole('link')).toHaveAttribute('data-router', 'yes')
  })

  it('shows a counter, including zero', () => {
    const { rerender } = render(<TextLink href="/a" label="Open plans" counter={3} />)
    expect(screen.getByRole('link')).toHaveTextContent('Open plans(3)')

    rerender(<TextLink href="/a" label="Open plans" counter={0} />)
    expect(screen.getByRole('link')).toHaveTextContent('Open plans(0)')
  })

  it('hides the chevron from assistive technology and leaves it out on request', () => {
    const { container, rerender } = render(<TextLink href="/a" label="Open plans" />)
    expect(container.querySelector('svg')?.parentElement).toHaveAttribute('aria-hidden', 'true')

    rerender(<TextLink href="/a" label="Open plans" hasChevron={false} />)
    expect(container.querySelector('svg')).toBeNull()
  })

  it('calls onClick', async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()
    // A router link handles the click itself; jsdom cannot navigate.
    function RouterLink({ href, children, onClick: handle, ...rest }: LinkComponentProps) {
      return (
        <a
          href={href}
          onClick={(event) => {
            event.preventDefault()
            handle?.(event)
          }}
          {...rest}
        >
          {children}
        </a>
      )
    }
    render(
      <LinkProvider component={RouterLink}>
        <TextLink href="/a" label="Open plans" onClick={onClick} />
      </LinkProvider>,
    )

    await user.click(screen.getByRole('link'))

    expect(onClick).toHaveBeenCalledOnce()
  })

  it.each(['https://example.com/phish', '//example.com', 'javascript:alert(1)'])(
    'renders the label of %s as plain text, not as a link',
    (href) => {
      render(<TextLink href={href} label="Open docs" />)

      expect(screen.queryByRole('link')).not.toBeInTheDocument()
      expect(screen.getByText('Open docs')).toBeInTheDocument()
    },
  )

  it('has no accessibility violations', async () => {
    const { container } = render(<TextLink href="/changes/plans" label="View plans" counter={2} />)

    expect(await axeViolations(container)).toEqual([])
  })
})
