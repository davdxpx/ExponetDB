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
    const { container } = render(<UntrustedName name="reosa/platform/production" />)

    expect(container).toHaveTextContent('reosa/platform/production')
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

  it('takes the length from a prop', () => {
    const { container } = render(<UntrustedName name={'n'.repeat(30)} maxCodePoints={10} />)

    expect(container.textContent).toContain('n'.repeat(10))
    expect(container.textContent).not.toContain('n'.repeat(11))
  })

  it('isolates the name from the direction of its surroundings', () => {
    const { container } = render(<UntrustedName name="abc" />)

    expect(container.querySelector('[dir="ltr"]')).not.toBeNull()
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
