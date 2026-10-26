import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { UntrustedName } from '../../src/untrusted/untrusted-name.tsx'
import { axeViolations } from '../support/axe.ts'
import { containsInvisible } from '../support/untrusted.ts'

afterEach(cleanup)

describe('UntrustedName', () => {
  it('renders a name as text', () => {
    const { container } = render(<UntrustedName name="acme/platform/production" />)

    expect(container).toHaveTextContent('acme/platform/production')
    expect(screen.queryByText('name not verified')).toBeNull()
  })

  it('renders markup in a name as text', () => {
    const name = '<img src=x onerror=alert(1)>'
    const { container } = render(<UntrustedName name={name} />)

    expect(container.textContent).toBe(name)
    expect(container.querySelector('img')).toBeNull()
  })

  it('shows direction, joiner and tag characters by code point', () => {
    const { container } = render(<UntrustedName name={'ad\u{202E}min\u{200D}\u{E0041}'} />)

    expect(screen.getByText('⟨U+202E⟩')).toBeInTheDocument()
    expect(screen.getByText('⟨U+200D⟩')).toBeInTheDocument()
    expect(screen.getByText('⟨U+E0041⟩')).toBeInTheDocument()
    expect(containsInvisible(container.textContent ?? '')).toBe(false)
  })

  it('never takes a second line: a line break inside the name is shown by code point', () => {
    const { container } = render(<UntrustedName name={'admin\nroot\rx'} />)

    expect(screen.getByText('⟨U+000A⟩')).toBeInTheDocument()
    expect(screen.getByText('⟨U+000D⟩')).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/[\n\r]/)
  })

  it('marks a look-alike letter', () => {
    const { container } = render(<UntrustedName name={'аdmin'} />)

    expect(container.querySelector('[data-segment="non-ascii"]')).toHaveAttribute(
      'data-code-point',
      'U+0430',
    )
  })

  it('adds the marker "name not verified" only when asked', () => {
    const { rerender } = render(<UntrustedName name="Some client" />)
    expect(screen.queryByText('name not verified')).toBeNull()

    rerender(<UntrustedName name="Some client" unverified />)

    expect(screen.getByText('name not verified')).toBeInTheDocument()
  })

  it('says so when the name is empty', () => {
    render(<UntrustedName name="" />)

    expect(screen.getByText('(empty)')).toBeInTheDocument()
  })

  it('cuts a long name and shows all of it only on request', async () => {
    const user = userEvent.setup()
    const name = 'n'.repeat(200)
    const { container } = render(<UntrustedName name={name} label="client name" />)

    expect(container.textContent).not.toContain('n'.repeat(81))
    const button = screen.getByRole('button', { name: 'Show all (200 characters) of client name' })

    await user.click(button)

    expect(container.textContent).toContain(name)
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument()
  })

  it('says so when even the expanded name is cut at the hard limit', async () => {
    const user = userEvent.setup()
    render(<UntrustedName name={'n'.repeat(100_010)} label="client name" />)
    await user.click(screen.getByRole('button', { name: /^Show all/ }))
    expect(
      screen.getByText(/^Showing the first 100,000 of 100,010 characters\.$/),
    ).toBeInTheDocument()
  })

  it('takes the length from a prop', () => {
    const { container } = render(<UntrustedName name={'n'.repeat(30)} maxCodePoints={10} />)

    expect(container.textContent).toContain('n'.repeat(10))
    expect(container.textContent).not.toContain('n'.repeat(11))
  })

  it('isolates the name and keeps its characters in stored order (the order itself is pinned in Chromium)', () => {
    const { container } = render(<UntrustedName name="abc" />)

    const ltr = container.querySelector('[dir="ltr"]')
    expect(ltr).not.toBeNull()
    expect(ltr?.className).toContain('[unicode-bidi:isolate-override]')
  })

  it('has no accessibility violations', async () => {
    const { container } = render(
      <ul>
        <li>
          <UntrustedName name={`${'x'.repeat(200)}\u{202E}`} unverified label="client name" />
        </li>
      </ul>,
    )

    expect(await axeViolations(container)).toEqual([])
  })
})

describe('UntrustedName inside a link', () => {
  it('cuts a long name with an ellipsis and offers no button when it is not expandable', () => {
    const long = 'a'.repeat(200)
    render(
      <a href="/t/acme/platform/staging">
        <UntrustedName name={long} expandable={false} maxCodePoints={10} />
      </a>,
    )
    expect(screen.queryByRole('button')).toBeNull()
    // Shortened, and said to be: the ellipsis is hidden from a screen reader, the words are not.
    expect(screen.getByRole('link').textContent).toBe(`${'a'.repeat(10)}… (shortened)`)
    expect(screen.getByText('(shortened)')).toHaveClass('sr-only')
  })
})
