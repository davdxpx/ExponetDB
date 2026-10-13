import '@testing-library/jest-dom/vitest'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { MarkedCode, markedCount } from '../../src/confirmations/marked-code.tsx'

afterEach(cleanup)

function codeOf(text: string): HTMLElement {
  const { container } = render(<MarkedCode text={text} />)
  const code = container.querySelector('code')
  if (code === null) throw new Error('no code element')
  return code
}

describe('MarkedCode', () => {
  it('renders plain ASCII as it is, in a code element', () => {
    const code = codeOf('shop/platform/production')
    expect(code.tagName).toBe('CODE')
    expect(code).toHaveTextContent('shop/platform/production')
    expect(code.querySelector('[data-marked]')).toBeNull()
    // A page translator leaves it alone; the page direction does not reorder it.
    expect(code).toHaveAttribute('translate', 'no')
    expect(code).toHaveAttribute('dir', 'ltr')
  })

  it('shows invisible and direction characters by code point instead of applying them', () => {
    const code = codeOf('users\u200b\u202eexe.txt')
    const hidden = code.querySelectorAll('[data-marked="hidden"]')
    expect([...hidden].map((node) => node.textContent)).toEqual(['⟨U+200B⟩', '⟨U+202E⟩'])
    // The characters themselves are never in the document.
    expect(code.textContent).not.toContain('\u200b')
    expect(code.textContent).not.toContain('\u202e')
  })

  it('marks characters outside printable ASCII and names their code point', () => {
    const code = codeOf('p\u0430yments')
    const marked = code.querySelector('[data-marked="non-ascii"]')
    expect(marked).not.toBeNull()
    expect(marked).toHaveTextContent('\u0430 (U+0430)')
  })

  it('shows a tab as an arrow with a spoken name', () => {
    const code = codeOf('a\tb')
    expect(code).toHaveTextContent('a→(tab)b')
  })

  it('renders markup as text', () => {
    const code = codeOf('<img src=x onerror=alert(1)>')
    expect(code.querySelector('img')).toBeNull()
    expect(code).toHaveTextContent('<img src=x onerror=alert(1)>')
  })

  it('counts the marked characters', () => {
    expect(markedCount('shop/platform/production')).toBe(0)
    expect(markedCount('users\u200b')).toBe(1)
    expect(markedCount('p\u0430yments\u202e')).toBe(2)
  })
})
