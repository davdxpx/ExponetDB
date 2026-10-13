import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { MAX_DIFF_CHARACTERS } from '../../src/editor/diff-types.ts'
import { TextDiffView } from '../../src/editor/text-diff.tsx'
import { axeViolations } from '../support/axe.ts'
import { installAdoptedSheets, installLayoutStubs, shadowOf, viewsOf } from './support.ts'

beforeAll(installLayoutStubs)
afterEach(cleanup)

const BEFORE = 'create table t (\n  id int primary key,\n  name text\n);'
const AFTER =
  'create table t (\n  id bigint primary key,\n  name text,\n  created_at timestamptz\n);'

function renderDiff(props: Partial<Parameters<typeof TextDiffView>[0]> = {}) {
  const view = render(
    <TextDiffView label="up.sql: draft against applied" before={BEFORE} after={AFTER} {...props} />,
  )
  const root = shadowOf(view.container)
  const [a, b] = viewsOf(root)
  if (a === undefined || b === undefined) throw new Error('both sides are expected')
  return { ...view, root, a, b }
}

const linesOf = (root: ParentNode) =>
  Array.from(root.querySelectorAll('.cm-line')).map((line) => line.textContent)

describe('TextDiffView: both sides', () => {
  it('mounts two read-only editors in an open shadow root, named and labelled', () => {
    const { container, root, a, b } = renderDiff()
    expect(container.querySelector('[data-exdb-editor="diff"]')?.shadowRoot?.mode).toBe('open')
    expect(container.querySelector('.cm-editor')).toBeNull()
    expect(root.querySelectorAll('.cm-editor')).toHaveLength(2)
    expect(screen.getByRole('group', { name: 'up.sql: draft against applied' })).toBeInTheDocument()
    expect(a.contentDOM).toHaveAttribute('aria-label', 'Before, read-only text')
    expect(b.contentDOM).toHaveAttribute('aria-label', 'After, read-only text')
    for (const side of [a, b]) {
      expect(side.contentDOM).toHaveAttribute('contenteditable', 'false')
      expect(side.contentDOM).toHaveAttribute('aria-readonly', 'true')
      expect(side.contentDOM).toHaveAttribute('tabindex', '0')
      expect(side.state.readOnly).toBe(true)
    }
    // The visible column headings say the same.
    expect(screen.getByText('Before')).toBeInTheDocument()
    expect(screen.getByText('After')).toBeInTheDocument()
  })

  it('shows the before text on the left and the after text on the right', () => {
    const { a, b } = renderDiff()
    expect(a.state.doc.toString()).toBe(BEFORE)
    expect(b.state.doc.toString()).toBe(AFTER)
    expect(linesOf(a.dom)).toEqual(BEFORE.split('\n'))
    expect(linesOf(b.dom)).toEqual(AFTER.split('\n'))
  })

  it('marks the changed lines on each side and the changed text as ins and del', () => {
    const { a, b } = renderDiff()
    const changedBefore = Array.from(a.dom.querySelectorAll('.cm-changedLine')).map(
      (l) => l.textContent,
    )
    const changedAfter = Array.from(b.dom.querySelectorAll('.cm-changedLine')).map(
      (l) => l.textContent,
    )
    expect(changedBefore).toEqual(['  id int primary key,', '  name text'])
    expect(changedAfter).toEqual([
      '  id bigint primary key,',
      '  name text,',
      '  created_at timestamptz',
    ])
    expect(a.dom.querySelector('del')).not.toBeNull()
    expect(b.dom.querySelector('ins')).not.toBeNull()
    // Unchanged lines carry no mark.
    expect(
      Array.from(a.dom.querySelectorAll('.cm-line')).find((l) => l.textContent === ');'),
    ).not.toHaveClass('cm-changedLine')
  })

  it('has a change gutter on both sides', () => {
    const { a, b } = renderDiff()
    expect(a.dom.querySelectorAll('.cm-changedLineGutter').length).toBe(2)
    expect(b.dom.querySelectorAll('.cm-changedLineGutter').length).toBe(3)
  })

  it('has line numbers on both sides', () => {
    const { a, b } = renderDiff()
    expect(a.dom.querySelector('.cm-lineNumbers')).toHaveTextContent('1')
    expect(b.dom.querySelector('.cm-lineNumbers')).toHaveTextContent('5')
  })

  it('says in words what differs', () => {
    renderDiff()
    expect(screen.getByRole('status')).toHaveTextContent(
      '1 changed block (Before: 2 lines, After: 3 lines)',
    )
  })

  it('uses the labels the caller gives, as text', () => {
    const { a, b } = renderDiff({ beforeLabel: 'Applied <b>v1</b>\u{202E}', afterLabel: 'Draft' })
    expect(screen.getByText('Applied <b>v1</b>⟨U+202E⟩')).toBeInTheDocument()
    expect(a.contentDOM.getAttribute('aria-label')).toBe(
      'Applied <b>v1</b>⟨U+202E⟩, read-only text',
    )
    expect(b.contentDOM.getAttribute('aria-label')).toBe('Draft, read-only text')
    expect(screen.getByRole('status')).toHaveTextContent(
      'Applied <b>v1</b>⟨U+202E⟩: 2 lines, Draft: 3 lines',
    )
    expect(document.querySelector('b')).toBeNull()
  })

  it('creates exactly two editors in StrictMode', () => {
    const { container, unmount } = render(
      <StrictMode>
        <TextDiffView label="diff" before={BEFORE} after={AFTER} />
      </StrictMode>,
    )
    const root = shadowOf(container)
    expect(root.querySelectorAll('.cm-editor')).toHaveLength(2)
    unmount()
    expect(root.querySelectorAll('.cm-editor')).toHaveLength(0)
  })

  it('recomputes when the texts change', () => {
    const view = renderDiff()
    view.rerender(<TextDiffView label="diff" before="a" after="b" />)
    const root = shadowOf(view.container)
    const [a, b] = viewsOf(root)
    expect(a?.state.doc.toString()).toBe('a')
    expect(b?.state.doc.toString()).toBe('b')
    expect(screen.getByRole('status')).toHaveTextContent(
      '1 changed block (Before: 1 line, After: 1 line)',
    )
  })

  it('treats CR and CRLF as line breaks', () => {
    const { a } = renderDiff({ before: 'a\r\nb\rc', after: 'a\nb\nc' })
    expect(a.state.doc.lines).toBe(3)
    expect(screen.getByRole('status')).toHaveTextContent('No differences')
  })
})

describe('TextDiffView: no differences', () => {
  it('says so, shows the text, and offers nothing to step through', () => {
    const { a, b } = renderDiff({ before: BEFORE, after: BEFORE })
    expect(screen.getByRole('status')).toHaveTextContent('No differences')
    expect(linesOf(a.dom)).toEqual(BEFORE.split('\n'))
    expect(linesOf(b.dom)).toEqual(BEFORE.split('\n'))
    expect(screen.getByRole('button', { name: 'Previous change' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next change' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Show all lines' })).toBeNull()
    expect(a.dom.querySelector('.cm-changedLine')).toBeNull()
  })

  it('also handles two empty texts', () => {
    renderDiff({ before: '', after: '' })
    expect(screen.getByRole('status')).toHaveTextContent('No differences')
  })
})

describe('TextDiffView: long unchanged runs', () => {
  const numbered = (n: number, change?: string) =>
    Array.from({ length: n }, (_, i) =>
      i === 25 && change !== undefined ? change : `line ${i + 1}`,
    ).join('\n')

  it('collapses them, and a button shows every line', () => {
    const { root, a } = renderDiff({ before: numbered(60), after: numbered(60, 'line 26 changed') })
    expect(root.querySelectorAll('.cm-collapsedLines').length).toBeGreaterThan(0)
    expect(root.querySelector('.cm-collapsedLines')?.textContent).toMatch(
      /\d+ unchanged lines hidden/,
    )
    const shownCollapsed = a.dom.querySelectorAll('.cm-line').length
    expect(shownCollapsed).toBeLessThan(60)

    const toggle = screen.getByRole('button', { name: 'Show all lines' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    const after = shadowOf(document.body)
    expect(after.querySelectorAll('.cm-collapsedLines')).toHaveLength(0)
    // jsdom has no layout, so the view draws only a window of the lines; more than before is what counts.
    expect(viewsOf(after)[0]?.dom.querySelectorAll('.cm-line').length).toBeGreaterThan(
      shownCollapsed,
    )
    expect(screen.getByRole('button', { name: 'Show all lines' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Show all lines' }))
    expect(shadowOf(document.body).querySelectorAll('.cm-collapsedLines').length).toBeGreaterThan(0)
  })

  it('does not collapse when asked not to, and offers no button', () => {
    const { root } = renderDiff({
      before: numbered(60),
      after: numbered(60, 'line 26 changed'),
      collapseUnchanged: false,
    })
    expect(root.querySelectorAll('.cm-collapsedLines')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Show all lines' })).toBeNull()
  })
})

describe('TextDiffView: stepping through changes', () => {
  const before = Array.from({ length: 40 }, (_, i) => `row ${i}`).join('\n')
  const after = before.replace('row 5\n', 'row five\n').replace('row 30\n', 'row thirty\n')

  it('moves between the changed blocks with the buttons', () => {
    const { b } = renderDiff({ before, after })
    expect(screen.getByRole('status')).toHaveTextContent('2 changed blocks')
    const head = () => b.state.doc.lineAt(b.state.selection.main.head).number
    fireEvent.click(screen.getByRole('button', { name: 'Next change' }))
    expect(head()).toBe(6)
    fireEvent.click(screen.getByRole('button', { name: 'Next change' }))
    expect(head()).toBe(31)
    fireEvent.click(screen.getByRole('button', { name: 'Previous change' }))
    expect(head()).toBe(6)
  })
})

describe('TextDiffView: content is data (C-26)', () => {
  it('keeps markup in either text as text', () => {
    const { root, container } = renderDiff({
      before: "select '<script>window.__pwned = 1</script>'",
      after: "select '<img src=x onerror=alert(1)>'",
    })
    expect(root.querySelector('script')).toBeNull()
    expect(root.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(Reflect.get(window, '__pwned')).toBeUndefined()
    expect(root.textContent).toContain('<script>window.__pwned = 1</script>')
    expect(root.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('shows direction characters as code points on both sides', () => {
    const { a, b } = renderDiff({ before: 'grant \u{202E}all', after: 'grant \u{2066}all' })
    expect(a.dom.querySelector('.exdb-hidden-char')).toHaveTextContent('⟨U+202E⟩')
    expect(b.dom.querySelector('.exdb-hidden-char')).toHaveTextContent('⟨U+2066⟩')
    expect(a.dom.textContent).not.toContain('\u{202E}')
    expect(b.dom.textContent).not.toContain('\u{2066}')
  })

  it('underlines look-alike letters', () => {
    const { b } = renderDiff({ before: 'select admin', after: 'select аdmin' })
    expect(
      Array.from(b.dom.querySelectorAll('.exdb-non-ascii')).map((el) => el.textContent),
    ).toEqual(['а'])
  })
})

describe('TextDiffView: size limit', () => {
  it('compares nothing above the limit and says why, with the numbers', () => {
    const big = 'x'.repeat(MAX_DIFF_CHARACTERS + 1)
    const { container } = render(<TextDiffView label="big" before={big} after="y" />)
    expect(container.querySelector('[data-exdb-editor="diff"]')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('Too large to compare here')
    expect(container).toHaveTextContent('Each side can hold at most 1,000,000 characters.')
    expect(container).toHaveTextContent('Before has 1,000,001, After has 1.')
    expect(screen.queryByRole('button', { name: 'Next change' })).toBeNull()
  })

  it('compares a text at the limit', () => {
    const edge = 'x'.repeat(MAX_DIFF_CHARACTERS)
    const { container } = render(<TextDiffView label="edge" before={edge} after={edge} />)
    expect(container.querySelector('[data-exdb-editor="diff"]')).not.toBeNull()
  })
})

describe('TextDiffView: style rules under the CSP', () => {
  it('adds no <style> element to the page', () => {
    renderDiff()
    expect(document.head.querySelectorAll('style')).toHaveLength(0)
    expect(document.querySelectorAll('style')).toHaveLength(0)
  })

  it('adopts its rules into the shadow root, which only works when the root is named', () => {
    const adopted = installAdoptedSheets()
    try {
      const { root } = renderDiff()
      expect(root.querySelector('style')).toBeNull()
      expect(document.querySelectorAll('style')).toHaveLength(0)
      const rules = adopted.sheets.flatMap((sheet) => sheet.rules).join('\n')
      expect(rules).toContain('.cm-mergeView')
      expect(rules).toContain('var(--destructive-200)')
      expect(rules).toContain('var(--success-200)')
      // None of the library's hard-coded diff colors is left in a rule that decides a color.
      expect(root.adoptedStyleSheets).toHaveLength(1)
    } finally {
      adopted.restore()
    }
  })
})

describe('TextDiffView: accessibility', () => {
  it('has no axe violations', async () => {
    const { container } = renderDiff()
    expect(await axeViolations(container)).toEqual([])
  })

  it('has no axe violations without differences, or when too large', async () => {
    const same = renderDiff({ before: BEFORE, after: BEFORE })
    expect(await axeViolations(same.container)).toEqual([])
    cleanup()
    const big = 'x'.repeat(MAX_DIFF_CHARACTERS + 1)
    const { container } = render(<TextDiffView label="big" before={big} after="y" />)
    expect(await axeViolations(container)).toEqual([])
  })

  it('keeps the buttons keyboard operable', () => {
    renderDiff()
    const next = screen.getByRole('button', { name: 'Next change' })
    next.focus()
    expect(document.activeElement).toBe(next)
    const group = screen.getByRole('group', { name: 'up.sql: draft against applied' })
    expect(within(group).getAllByRole('button').length).toBeGreaterThanOrEqual(3)
  })
})
