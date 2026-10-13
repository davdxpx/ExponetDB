import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { ClippedText, clipVisible, visibleText } from '../../src/charts/clipped-text.tsx'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

describe('visibleText', () => {
  it('shows direction and invisible characters by code point', () => {
    expect(visibleText('abc‮def')).toBe('abc⟨U+202E⟩def')
    expect(visibleText('a​b')).toBe('a⟨U+200B⟩b')
    expect(visibleText('x\u{E0041}y')).toBe('x⟨U+E0041⟩y')
  })

  it('shows a tab as an arrow and keeps plain and non-ASCII text', () => {
    expect(visibleText('a\tb')).toBe('a→b')
    expect(visibleText('café')).toBe('café')
  })

  it('shows a line break as a code point instead of starting a new line', () => {
    expect(visibleText('a\nb')).toBe('a⟨U+000A⟩b')
  })
})

describe('clipVisible', () => {
  it('keeps a short text whole and cuts a long one with an ellipsis', () => {
    expect(clipVisible('short', 10)).toBe('short')
    expect(clipVisible('abcdefghij', 4)).toBe('abcd…')
  })

  it('never cuts a code point label in the middle', () => {
    expect(clipVisible('ab‮cd', 3)).toBe('ab⟨U+202E⟩…')
  })
})

describe('ClippedText', () => {
  it('shows a short value as it is, with no control', () => {
    render(<ClippedText text="orders_db" />)
    expect(screen.getByText('orders_db')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('truncates a long value and expands it on request', async () => {
    const user = userEvent.setup()
    const text = `${'a'.repeat(30)}${'b'.repeat(30)}`
    render(<ClippedText text={text} limit={30} />)

    expect(screen.getByText(`${'a'.repeat(30)}…`)).toBeInTheDocument()
    const more = screen.getByRole('button', { name: 'Show more' })
    expect(more).toHaveAttribute('aria-expanded', 'false')

    await user.click(more)
    expect(screen.getByText(text)).toBeInTheDocument()
    const less = screen.getByRole('button', { name: 'Show less' })
    expect(less).toHaveAttribute('aria-expanded', 'true')

    await user.click(less)
    expect(screen.getByText(`${'a'.repeat(30)}…`)).toBeInTheDocument()
  })

  it('says how much an expanded value still leaves out', async () => {
    const user = userEvent.setup()
    render(<ClippedText text={'x'.repeat(5000)} limit={10} />)
    await user.click(screen.getByRole('button', { name: 'Show more' }))
    expect(screen.getByText(/1000 more characters not shown/)).toBeInTheDocument()
  })

  it('renders markup in the value as text and marks hidden characters', () => {
    const { container } = render(
      <ClippedText text={'<img src=x onerror=alert(1)><script>boom()</script>‮evil'} limit={200} />,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container).toHaveTextContent(
      '<img src=x onerror=alert(1)><script>boom()</script>⟨U+202E⟩evil',
    )
  })

  it('has no accessibility violations', async () => {
    render(
      <ul>
        <li>
          <ClippedText text={'z'.repeat(200)} limit={20} />
        </li>
      </ul>,
    )
    expect(await axeViolations()).toEqual([])
  })
})
