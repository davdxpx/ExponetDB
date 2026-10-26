import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { LinkCard } from '../../src/link-card/index.tsx'
import { type LinkComponentProps, LinkProvider } from '../../src/seams/index.ts'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

describe('LinkCard', () => {
  it('is one link for the whole card, named by its content', () => {
    render(
      <LinkCard href="/findings?severity=critical">
        <p>Critical findings</p>
        <p>519</p>
      </LinkCard>,
    )
    const link = screen.getByRole('link', { name: /Critical findings\s*519/ })
    expect(link).toHaveAttribute('href', '/findings?severity=critical')
    expect(screen.getAllByRole('link')).toHaveLength(1)
  })

  it('takes an explicit accessible name and is reached once from the keyboard', async () => {
    render(
      <>
        <button type="button">before</button>
        <LinkCard href="/targets" aria-label="Open the databases, 7 targets">
          <span>Targets</span>
        </LinkCard>
      </>,
    )
    await userEvent.tab()
    await userEvent.tab()
    expect(screen.getByRole('link', { name: 'Open the databases, 7 targets' })).toHaveFocus()
  })

  it('renders through the link seam, so the router handles the click', () => {
    function RouterLink({ href, children, ...rest }: LinkComponentProps) {
      return (
        <a href={href} data-router="yes" {...rest}>
          {children}
        </a>
      )
    }
    render(
      <LinkProvider component={RouterLink}>
        <LinkCard href="/projects">Projects</LinkCard>
      </LinkProvider>,
    )
    expect(screen.getByRole('link', { name: 'Projects' })).toHaveAttribute('data-router', 'yes')
  })

  it('marks its tone as data, never as the only signal', () => {
    render(
      <LinkCard href="/findings" tone="critical">
        2 critical findings
      </LinkCard>,
    )
    expect(screen.getByRole('link')).toHaveAttribute('data-tone', 'critical')
  })

  it('has no accessibility violations', async () => {
    const { container } = render(
      <LinkCard href="/targets">
        <h3>Databases</h3>
        <p>7 targets</p>
      </LinkCard>,
    )
    expect(await axeViolations(container)).toEqual([])
  })
})
