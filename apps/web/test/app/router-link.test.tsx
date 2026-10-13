import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { routerLink } from '../../src/app/providers.tsx'

afterEach(cleanup)

describe('the router link of the design-system seam', () => {
  it('navigates inside the app on a plain left click', () => {
    const navigate = vi.fn()
    const Link = routerLink(navigate)
    render(<Link href="/changes/plans">Plans</Link>)
    const link = screen.getByRole('link', { name: 'Plans' })
    expect(link.getAttribute('href')).toBe('/changes/plans')
    fireEvent.click(link, { button: 0 })
    expect(navigate).toHaveBeenCalledWith('/changes/plans')
  })

  it('leaves modified clicks and links with a target to the browser', () => {
    const navigate = vi.fn()
    const Link = routerLink(navigate)
    render(
      <>
        <Link href="/audit">Audit</Link>
        <Link href="/approvals" target="_self">
          Approvals
        </Link>
      </>,
    )
    fireEvent.click(screen.getByRole('link', { name: 'Audit' }), { button: 0, ctrlKey: true })
    fireEvent.click(screen.getByRole('link', { name: 'Audit' }), { button: 1 })
    fireEvent.click(screen.getByRole('link', { name: 'Approvals' }), { button: 0 })
    expect(navigate).not.toHaveBeenCalled()
  })
})
