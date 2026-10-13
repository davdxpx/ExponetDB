import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { EXPANDED_CODE_POINT_LIMIT } from '../../src/untrusted/truncate.ts'
import { UntrustedText } from '../../src/untrusted/untrusted-text.tsx'
import { axeViolations } from '../support/axe.ts'
import { containsInvisible } from '../support/untrusted.ts'

afterEach(cleanup)

describe('UntrustedText', () => {
  it('renders markup-looking text as text and creates no element from it', () => {
    const hostile =
      '<script>alert(1)</script><img src=x onerror=alert(1)> <a href="javascript:alert(1)">x</a>'
    const { container } = render(<UntrustedText text={hostile} />)

    expect(container.textContent).toBe(hostile)
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('renders Markdown and bare URLs as plain text, not as formatting or links', () => {
    const text = '**bold** [link](https://example.test) https://example.test'
    const { container } = render(<UntrustedText text={text} />)

    expect(container.textContent).toBe(text)
    expect(container.querySelector('strong, em, a')).toBeNull()
  })

  it('shows a right-to-left override by code point and never passes the raw character on', () => {
    const { container } = render(<UntrustedText text={'SELECT 1; --\u{202E}ecnalupmoc'} />)

    expect(screen.getByText('⟨U+202E⟩')).toBeInTheDocument()
    expect(container.textContent).not.toContain('\u{202E}')
    expect(container.textContent).toContain('hidden character U+202E, right-to-left override')
  })

  it('shows zero-width joiners and spaces by code point', () => {
    const { container } = render(<UntrustedText text={'ad\u{200D}min\u{200B}'} />)

    expect(screen.getByText('⟨U+200D⟩')).toBeInTheDocument()
    expect(screen.getByText('⟨U+200B⟩')).toBeInTheDocument()
    expect(containsInvisible(container.textContent ?? '')).toBe(false)
    expect(container.textContent).toContain('zero width joiner')
    expect(container.textContent).toContain('zero width space')
  })

  it('shows tag characters by code point', () => {
    const { container } = render(<UntrustedText text={'ok\u{E0049}\u{E0047}\u{E004E}'} />)

    expect(screen.getByText('⟨U+E0049⟩')).toBeInTheDocument()
    expect(screen.getByText('⟨U+E0047⟩')).toBeInTheDocument()
    expect(screen.getByText('⟨U+E004E⟩')).toBeInTheDocument()
    expect(container.textContent).toContain('tag character')
    expect(containsInvisible(container.textContent ?? '')).toBe(false)
  })

  it('shows control characters by code point', () => {
    const { container } = render(<UntrustedText text={'a\u0000b\u001Bc\u0085d'} />)

    expect(screen.getByText('⟨U+0000⟩')).toBeInTheDocument()
    expect(screen.getByText('⟨U+001B⟩')).toBeInTheDocument()
    expect(screen.getByText('⟨U+0085⟩')).toBeInTheDocument()
    expect(containsInvisible(container.textContent ?? '')).toBe(false)
  })

  it('marks a look-alike letter and says how many characters it marked', () => {
    const { container } = render(<UntrustedText text={'pаypal'} />)

    const marked = container.querySelector('[data-segment="non-ascii"]')
    expect(marked).toHaveTextContent('а')
    expect(marked).toHaveAttribute('data-code-point', 'U+0430')
    expect(screen.getByText('1 non-ASCII character underlined')).toBeInTheDocument()
  })

  it('counts hidden characters in a caption', () => {
    render(<UntrustedText text={'a\u{200B}b\u{200C}c'} />)

    expect(screen.getByText('2 hidden characters shown as code points')).toBeInTheDocument()
  })

  it('shows a tab as an arrow with a spoken name', () => {
    const { container } = render(<UntrustedText text={'a\tb'} />)

    const tab = container.querySelector('[data-segment="tab"]')
    expect(tab).toHaveTextContent('→')
    expect(tab).toHaveTextContent('tab')
    expect(container.textContent).not.toContain('\t')
  })

  it('keeps every line, including after a lone carriage return', () => {
    const { container } = render(<UntrustedText text={'first\r\nsecond\rthird\nfourth'} />)

    expect(container.textContent).toBe('first\nsecond\nthird\nfourth')
    expect(container.textContent).not.toContain('\r')
  })

  it('says so when the value is empty', () => {
    render(<UntrustedText text="" />)

    expect(screen.getByText('(empty)')).toBeInTheDocument()
  })

  it('sets a fixed left-to-right direction', () => {
    const { container } = render(<UntrustedText text="abc" />)

    expect(container.querySelector('[dir="ltr"]')).not.toBeNull()
  })

  describe('truncation', () => {
    it('cuts a long value by code points and offers "Show all (N characters)"', async () => {
      const user = userEvent.setup()
      const { container } = render(<UntrustedText text={'a'.repeat(5000)} />)

      expect(container.textContent?.startsWith('a'.repeat(1000))).toBe(true)
      expect(container.textContent).not.toContain('a'.repeat(1001))
      const button = screen.getByRole('button', { name: 'Show all (5,000 characters)' })

      await user.click(button)

      expect(container.textContent).toContain('a'.repeat(5000))
      expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Show less' }))

      expect(container.textContent).not.toContain('a'.repeat(1001))
      expect(
        screen.getByRole('button', { name: 'Show all (5,000 characters)' }),
      ).toBeInTheDocument()
    })

    it('honors the limits given as props', () => {
      const { container } = render(<UntrustedText text={'a'.repeat(50)} maxCodePoints={10} />)

      expect(container.textContent).toContain('a'.repeat(10))
      expect(container.textContent).not.toContain('a'.repeat(11))
      expect(screen.getByRole('button', { name: 'Show all (50 characters)' })).toBeInTheDocument()
    })

    it('cuts by lines', async () => {
      const user = userEvent.setup()
      const text = Array.from({ length: 30 }, (_, n) => `line ${n + 1}`).join('\n')
      render(<UntrustedText text={text} maxLines={3} />)

      expect(screen.getByText(/line 3/)).toBeInTheDocument()
      expect(screen.queryByText(/line 4/)).toBeNull()

      await user.click(screen.getByRole('button', { name: /Show all/ }))

      expect(screen.getByText(/line 30/)).toBeInTheDocument()
    })

    it('counts code points, so an emoji counts once and is never cut in half', () => {
      const { container } = render(<UntrustedText text={'😀'.repeat(20)} maxCodePoints={5} />)

      expect(container.textContent).toContain('😀'.repeat(5))
      expect(container.textContent).not.toContain('😀'.repeat(6))
      expect(container.textContent).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
      expect(screen.getByRole('button', { name: 'Show all (20 characters)' })).toBeInTheDocument()
    })

    it('shows no button for a value within the limits', () => {
      render(<UntrustedText text="short" />)

      expect(screen.queryByRole('button')).toBeNull()
    })

    it('names the content for screen readers when a label is given', () => {
      render(<UntrustedText text={'a'.repeat(2000)} label="SQL text" />)

      expect(
        screen.getByRole('button', { name: 'Show all (2,000 characters) of SQL text' }),
      ).toBeInTheDocument()
    })

    it('starts collapsed again when the text changes', async () => {
      const user = userEvent.setup()
      const { rerender, container } = render(<UntrustedText text={'a'.repeat(3000)} />)
      await user.click(screen.getByRole('button', { name: /Show all/ }))
      expect(container.textContent).toContain('a'.repeat(3000))

      rerender(<UntrustedText text={'b'.repeat(3000)} />)

      expect(container.textContent).not.toContain('b'.repeat(1001))
      expect(
        screen.getByRole('button', { name: 'Show all (3,000 characters)' }),
      ).toBeInTheDocument()
    })

    it('stops at a hard limit even after "Show all" and says so', async () => {
      const user = userEvent.setup()
      const total = EXPANDED_CODE_POINT_LIMIT + 5_000
      const { container } = render(<UntrustedText text={'a'.repeat(total)} />)

      await user.click(screen.getByRole('button', { name: /Show all/ }))

      expect(container.textContent).toContain('a'.repeat(EXPANDED_CODE_POINT_LIMIT))
      expect(container.textContent).not.toContain('a'.repeat(EXPANDED_CODE_POINT_LIMIT + 1))
      expect(
        screen.getByText('Showing the first 100,000 of 105,000 characters.'),
      ).toBeInTheDocument()
    })

    it('marks hidden characters only in the part that is shown', () => {
      render(<UntrustedText text={`${'a'.repeat(20)}\u{202E}`} maxCodePoints={10} />)

      expect(screen.queryByText('⟨U+202E⟩')).toBeNull()
    })
  })

  it('has no accessibility violations', async () => {
    const { container } = render(
      <UntrustedText text={`one\ttwo\u{202E}\n${'x'.repeat(2000)} а`} label="comment" />,
    )

    expect(await axeViolations(container)).toEqual([])
  })
})
