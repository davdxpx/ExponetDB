import '@testing-library/jest-dom/vitest'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  highlightParts,
  TextHighlighterBase,
} from '../../../src/command-menu/api/text-highlighter.tsx'

afterEach(cleanup)

const joined = (parts: ReturnType<typeof highlightParts>) => parts.map((part) => part.text).join('')

describe('highlightParts', () => {
  it('marks the part that matches, whatever the case', () => {
    expect(highlightParts('Go to Plans', 'plans')).toEqual([
      { text: 'Go to ', match: false },
      { text: 'Plans', match: true },
    ])
  })

  it('marks every occurrence of every word of the query', () => {
    expect(highlightParts('Go to plans', 'go plans')).toEqual([
      { text: 'Go', match: true },
      { text: ' to ', match: false },
      { text: 'plans', match: true },
    ])
    expect(highlightParts('abab', 'ab')).toEqual([{ text: 'abab', match: true }])
  })

  it('merges words that overlap', () => {
    expect(highlightParts('production', 'prod duct')).toEqual([
      { text: 'product', match: true },
      { text: 'ion', match: false },
    ])
  })

  it('returns the text unmarked for an empty query or no match', () => {
    expect(highlightParts('Go to plans', '')).toEqual([{ text: 'Go to plans', match: false }])
    expect(highlightParts('Go to plans', '   ')).toEqual([{ text: 'Go to plans', match: false }])
    expect(highlightParts('Go to plans', 'zzz')).toEqual([{ text: 'Go to plans', match: false }])
    expect(highlightParts('', 'plans')).toEqual([{ text: '', match: false }])
  })

  it('always joins back to the text', () => {
    for (const [text, query] of [
      ['Switch to production', 'to prod sw'],
      ['a.b.c', '.'],
      ['<b>x</b>', 'b'],
      ['İstanbul', 'i'],
    ] as const) {
      expect(joined(highlightParts(text, query)), `${text} / ${query}`).toBe(text)
    }
  })

  it('does not match special characters as a pattern', () => {
    expect(highlightParts('a.c abc', 'a.c')).toEqual([
      { text: 'a.c', match: true },
      { text: ' abc', match: false },
    ])
    expect(highlightParts('x (y) z', '(y')).toEqual([
      { text: 'x ', match: false },
      { text: '(y', match: true },
      { text: ') z', match: false },
    ])
  })

  it('limits the work for a very long query', () => {
    const query = `${'a '.repeat(500)}b`
    expect(() => highlightParts('a b', query)).not.toThrow()
  })
})

describe('TextHighlighterBase', () => {
  it('renders the text with the match in its own element', () => {
    const { container } = render(
      <TextHighlighterBase query="plan">Go to plans</TextHighlighterBase>,
    )

    expect(container).toHaveTextContent('Go to plans')
    expect(container.querySelector('.font-semibold')).toHaveTextContent('plan')
  })

  it('renders markup in the text as text', () => {
    const hostile = '<img src=x onerror="document.title=1"><script>1</script>'
    const { container } = render(<TextHighlighterBase query="img" text={hostile} />)

    expect(container).toHaveTextContent(hostile)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
  })

  it('renders something other than a string child as it is', () => {
    const { container } = render(
      <TextHighlighterBase query="plan">
        <strong>Go to plans</strong>
      </TextHighlighterBase>,
    )

    expect(container.querySelector('strong')).toHaveTextContent('Go to plans')
  })
})
