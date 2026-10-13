import '@testing-library/jest-dom/vitest'
import { startCompletion } from '@codemirror/autocomplete'
import { deleteCharBackward, insertNewlineAndIndent } from '@codemirror/commands'
import { openSearchPanel } from '@codemirror/search'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { createRef, StrictMode } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { SqlEditor } from '../../src/editor/sql-editor.tsx'
import type {
  EditorHandle,
  SqlCompletionProvider,
  SqlDiagnostic,
  SqlEditorProps,
} from '../../src/editor/types.ts'
import { axeViolations } from '../support/axe.ts'
import { installAdoptedSheets, installLayoutStubs, shadowOf, viewOf } from './support.ts'

beforeAll(installLayoutStubs)
afterEach(cleanup)

function renderEditor(props: Partial<SqlEditorProps> = {}) {
  const view = render(<SqlEditor value="select 1" mode="draft" label="Migration SQL" {...props} />)
  const root = shadowOf(view.container)
  return { ...view, root, editor: viewOf(root) }
}

const text = (root: ShadowRoot) =>
  Array.from(root.querySelectorAll('.cm-line'))
    .map((line) => line.textContent)
    .join('\n')

describe('SqlEditor: mounting', () => {
  it('mounts CodeMirror inside an open shadow root, not in the page', () => {
    const { container, root } = renderEditor()
    const host = container.querySelector('[data-exdb-editor="sql"]')
    expect(host?.shadowRoot?.mode).toBe('open')
    expect(root.querySelector('.cm-editor')).not.toBeNull()
    expect(container.querySelector('.cm-editor')).toBeNull()
    expect(document.querySelector('.cm-editor')).toBeNull()
  })

  it('names the text box and shows the value', () => {
    const { root } = renderEditor({ value: 'select 1;\nselect 2;' })
    const box = within(root.querySelector('.cm-editor') as HTMLElement).getByRole('textbox', {
      name: 'Migration SQL',
    })
    expect(box).toHaveAttribute('aria-multiline', 'true')
    expect(text(root)).toBe('select 1;\nselect 2;')
  })

  it('is in the tab order in every mode (a scrolling editor needs focusable content)', () => {
    for (const mode of ['query', 'draft', 'readonly'] as const) {
      const { editor, unmount } = renderEditor({ mode })
      expect(editor.contentDOM, mode).toHaveAttribute('tabindex', '0')
      unmount()
    }
  })

  it('creates exactly one editor in StrictMode and none after unmount', () => {
    const { container, unmount } = render(
      <StrictMode>
        <SqlEditor value="select 1" mode="draft" label="SQL" />
      </StrictMode>,
    )
    const root = shadowOf(container)
    expect(root.querySelectorAll('.cm-editor')).toHaveLength(1)
    unmount()
    expect(root.querySelectorAll('.cm-editor')).toHaveLength(0)
  })

  it('shows a placeholder while empty', () => {
    const { root } = renderEditor({ value: '', placeholder: 'Write a statement' })
    expect(root.querySelector('.cm-placeholder')).toHaveTextContent('Write a statement')
  })

  it('sets the height range through custom properties, not style text', () => {
    const { container } = renderEditor({ minLines: 5, maxLines: 12 })
    const host = container.querySelector<HTMLElement>('[data-exdb-editor]')
    expect(host?.style.getPropertyValue('--exdb-editor-min-height')).toBe('7.625rem')
    expect(host?.style.getPropertyValue('--exdb-editor-max-height')).toBe('17.25rem')
  })

  it('leaves the max height unset without maxLines', () => {
    const { container } = renderEditor()
    const host = container.querySelector<HTMLElement>('[data-exdb-editor]')
    expect(host?.style.getPropertyValue('--exdb-editor-max-height')).toBe('')
  })
})

describe('SqlEditor: style rules under the CSP', () => {
  it('adds no <style> element to the page, in the head or anywhere', () => {
    renderEditor({ diagnostics: [{ line: 1, severity: 'error', message: 'x' }] })
    expect(document.head.querySelectorAll('style')).toHaveLength(0)
    expect(document.querySelectorAll('style')).toHaveLength(0)
  })

  it('puts its rules into an adopted stylesheet of the shadow root when the browser has them', () => {
    const adopted = installAdoptedSheets()
    try {
      const { root, container } = renderEditor()
      expect(root.querySelector('style')).toBeNull()
      expect(document.querySelectorAll('style')).toHaveLength(0)
      expect(container.querySelectorAll('style')).toHaveLength(0)
      const sheet = adopted.sheets[0]
      expect(sheet).toBeDefined()
      const rules = sheet?.rules.join('\n') ?? ''
      expect(rules).toContain('.cm-scroller')
      // The theme is made of token custom properties, no color literal of its own.
      expect(rules).toContain('var(--foreground)')
      expect(rules).toContain('var(--ring)')
      expect(root.adoptedStyleSheets).toHaveLength(1)
    } finally {
      adopted.restore()
    }
  })
})

describe('SqlEditor: value and onChange', () => {
  it('reports an edit of the person with the whole text', () => {
    const onChange = vi.fn()
    const { editor } = renderEditor({ value: 'select 1', onChange })
    editor.dispatch({ changes: { from: 8, insert: ' + 1' }, userEvent: 'input.type' })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith('select 1 + 1')
  })

  it('takes a new value from outside without reporting it back', () => {
    const onChange = vi.fn()
    const view = renderEditor({ value: 'select 1', onChange })
    view.rerender(
      <SqlEditor value="select 2" mode="draft" label="Migration SQL" onChange={onChange} />,
    )
    expect(text(view.root)).toBe('select 2')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps the cursor of a person when the new value only changes text after it', () => {
    const view = renderEditor({ value: 'select 1' })
    view.editor.dispatch({ selection: { anchor: 3 } })
    view.rerender(<SqlEditor value="select 1 from t" mode="draft" label="Migration SQL" />)
    expect(view.editor.state.selection.main.head).toBe(3)
  })

  it('does not dispatch when the value is what the editor already shows', () => {
    const onChange = vi.fn()
    const view = renderEditor({ value: 'select 1', onChange })
    const before = view.editor.state.doc
    view.rerender(
      <SqlEditor value="select 1" mode="draft" label="Migration SQL" onChange={onChange} />,
    )
    expect(view.editor.state.doc).toBe(before)
  })

  it('round-trips a controlled value', () => {
    const seen: string[] = []
    const view = renderEditor({ value: 'a', onChange: (value) => seen.push(value) })
    view.editor.dispatch({ changes: { from: 1, insert: 'b' }, userEvent: 'input.type' })
    view.rerender(
      <SqlEditor value="ab" mode="draft" label="Migration SQL" onChange={(v) => seen.push(v)} />,
    )
    expect(seen).toEqual(['ab'])
    expect(text(view.root)).toBe('ab')
  })

  it('shows CR and CRLF as line breaks and reports LF', () => {
    const onChange = vi.fn()
    const { root, editor } = renderEditor({ value: 'a\r\nb\rc', onChange })
    expect(editor.state.doc.lines).toBe(3)
    expect(text(root)).toBe('a\nb\nc')
    editor.dispatch({ changes: { from: 0, insert: 'x' }, userEvent: 'input.type' })
    expect(onChange).toHaveBeenLastCalledWith('xa\nb\nc')
  })

  it('accepts typed keys in draft mode', () => {
    const onChange = vi.fn()
    const { editor } = renderEditor({ value: 'a', onChange })
    editor.focus()
    editor.dispatch({ selection: { anchor: 1 } })
    fireEvent.keyDown(editor.contentDOM, { key: 'Enter' })
    expect(onChange).toHaveBeenLastCalledWith('a\n')
  })
})

describe('SqlEditor: read-only display', () => {
  it('is not editable, says so, and stays focusable and selectable', () => {
    const onChange = vi.fn()
    const { root, editor } = renderEditor({ mode: 'readonly', value: 'select 1', onChange })
    const box = editor.contentDOM
    expect(box).toHaveAttribute('contenteditable', 'false')
    expect(box).toHaveAttribute('aria-readonly', 'true')
    expect(box).toHaveAttribute('tabindex', '0')
    editor.focus()
    expect(root.activeElement).toBe(box)
    editor.dispatch({ selection: { anchor: 0, head: 6 } })
    expect(
      editor.state.sliceDoc(editor.state.selection.main.from, editor.state.selection.main.to),
    ).toBe('select')
  })

  it('blocks edit commands and reports nothing', () => {
    const onChange = vi.fn()
    const { editor } = renderEditor({ mode: 'readonly', value: 'select 1', onChange })
    expect(editor.state.readOnly).toBe(true)
    editor.dispatch({ selection: { anchor: 8 } })
    expect(deleteCharBackward(editor)).toBe(false)
    expect(insertNewlineAndIndent(editor)).toBe(false)
    fireEvent.keyDown(editor.contentDOM, { key: 'Enter' })
    fireEvent.keyDown(editor.contentDOM, { key: 'Backspace' })
    expect(editor.state.doc.toString()).toBe('select 1')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('becomes editable when the mode changes to draft, and back', () => {
    const view = renderEditor({ mode: 'readonly' })
    view.rerender(<SqlEditor value="select 1" mode="draft" label="Migration SQL" />)
    expect(view.editor.contentDOM).toHaveAttribute('contenteditable', 'true')
    view.rerender(<SqlEditor value="select 1" mode="readonly" label="Migration SQL" />)
    expect(view.editor.contentDOM).toHaveAttribute('contenteditable', 'false')
  })
})

describe('SqlEditor: Mod+Enter runs only in query mode', () => {
  const press = (editor: ReturnType<typeof viewOf>) =>
    fireEvent.keyDown(editor.contentDOM, { key: 'Enter', ctrlKey: true })

  it('calls onRun once in query mode and keeps the text', () => {
    const onRun = vi.fn()
    const { editor } = renderEditor({ mode: 'query', onRun })
    const proceeded = press(editor)
    expect(onRun).toHaveBeenCalledTimes(1)
    expect(proceeded).toBe(false)
    expect(editor.state.doc.toString()).toBe('select 1')
  })

  it('does not call onRun in draft or readonly mode', () => {
    for (const mode of ['draft', 'readonly'] as const) {
      const onRun = vi.fn()
      const { editor, unmount } = renderEditor({ mode, onRun })
      press(editor)
      expect(onRun, mode).not.toHaveBeenCalled()
      unmount()
    }
  })

  it('leaves the key alone in query mode without onRun', () => {
    const { editor } = renderEditor({ mode: 'query' })
    expect(() => press(editor)).not.toThrow()
  })

  it('calls the current onRun after a re-render', () => {
    const first = vi.fn()
    const second = vi.fn()
    const view = renderEditor({ mode: 'query', onRun: first })
    view.rerender(<SqlEditor value="select 1" mode="query" label="Migration SQL" onRun={second} />)
    press(view.editor)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe('SqlEditor: diagnostics', () => {
  const findings: SqlDiagnostic[] = [
    { line: 2, column: 10, severity: 'error', message: 'syntax error at or near "FORM"' },
    { line: 1, severity: 'warning', message: 'select * is not stable' },
  ]
  const value = 'select *\nselect x FORM t'

  it('marks the lines, the line numbers and states every finding in words', () => {
    const { root } = renderEditor({ value, diagnostics: findings })
    const lines = Array.from(root.querySelectorAll('.cm-line'))
    expect(lines[0]).toHaveClass('exdb-diag-line-warning')
    expect(lines[1]).toHaveClass('exdb-diag-line-error')
    expect(root.querySelector('.exdb-diag-number-error')).not.toBeNull()
    expect(root.querySelector('.exdb-diag-number-warning')).not.toBeNull()
    // The line number is still there next to the symbol.
    expect(root.querySelector('.exdb-diag-number-error')?.textContent).toBe('2')
    const group = within(root.querySelector('.cm-editor') as HTMLElement).getByRole('group', {
      name: 'Problems',
    })
    expect(group).toHaveTextContent('2 problems: 1 error, 1 warning')
    expect(group).toHaveTextContent('Error at line 2, column 10: syntax error at or near "FORM"')
    expect(group).toHaveTextContent('Warning at line 1, column 1: select * is not stable')
  })

  it('underlines the word the column points at', () => {
    const { root } = renderEditor({ value, diagnostics: findings })
    const range = root.querySelector('.exdb-diag-range-error')
    expect(range?.textContent).toBe('FORM')
  })

  it('marks an explicit range', () => {
    const { root } = renderEditor({
      value: 'select 1 from t',
      diagnostics: [
        { line: 1, column: 8, endLine: 1, endColumn: 10, severity: 'info', message: 'm' },
      ],
    })
    expect(root.querySelector('.exdb-diag-range-info')?.textContent).toBe('1 ')
  })

  it('describes the text box by the summary and marks it invalid while an error exists', () => {
    const { root, editor } = renderEditor({ value, diagnostics: findings })
    const describedBy = editor.contentDOM.getAttribute('aria-describedby')
    expect(describedBy).not.toBeNull()
    const summary = root.getElementById(describedBy ?? '')
    expect(summary).toHaveTextContent('2 problems: 1 error, 1 warning')
    expect(editor.contentDOM).toHaveAttribute('aria-invalid', 'true')
  })

  it('is not invalid when there are only warnings', () => {
    const { editor } = renderEditor({
      value,
      diagnostics: [{ line: 1, severity: 'warning', message: 'w' }],
    })
    expect(editor.contentDOM).not.toHaveAttribute('aria-invalid')
    expect(editor.contentDOM).toHaveAttribute('aria-describedby')
  })

  it('moves the cursor to a finding when its entry is pressed', () => {
    const { root, editor } = renderEditor({ value, diagnostics: findings })
    const entry = within(root.querySelector('.cm-editor') as HTMLElement).getByRole('button', {
      name: /syntax error at or near/,
    })
    fireEvent.click(entry)
    expect(editor.state.selection.main.head).toBe(editor.state.doc.line(2).from + 9)
    expect(root.activeElement).toBe(editor.contentDOM)
  })

  it('removes everything when the findings are cleared', () => {
    const view = renderEditor({ value, diagnostics: findings })
    view.rerender(<SqlEditor value={value} mode="draft" label="Migration SQL" diagnostics={[]} />)
    expect(view.root.querySelector('.exdb-diag-line-error')).toBeNull()
    expect(view.root.querySelector('[role="group"]')).toBeNull()
    expect(view.editor.contentDOM).not.toHaveAttribute('aria-describedby')
  })

  it('does not reapply findings that did not change', () => {
    const view = renderEditor({ value, diagnostics: findings })
    const marked = view.root.querySelector('.cm-line.exdb-diag-line-error')
    view.rerender(
      <SqlEditor
        value={value}
        mode="draft"
        label="Migration SQL"
        diagnostics={findings.map((f) => ({ ...f }))}
      />,
    )
    expect(view.root.querySelector('.cm-line.exdb-diag-line-error')).toBe(marked)
  })

  it('keeps a finding on its text when lines are added above it', () => {
    const { root, editor } = renderEditor({ value, diagnostics: findings })
    editor.dispatch({ changes: { from: 0, insert: '-- note\n' }, userEvent: 'input.type' })
    const lines = Array.from(root.querySelectorAll('.cm-line'))
    expect(lines[2]).toHaveClass('exdb-diag-line-error')
    expect(root.querySelector('.exdb-diag-range-error')?.textContent).toBe('FORM')
    expect(
      within(root.querySelector('.cm-editor') as HTMLElement).getByRole('group'),
    ).toHaveTextContent('Error at line 3, column 10')
  })

  it('treats the message as text: no markup, invisible characters shown, cut at 500', () => {
    const { root } = renderEditor({
      value,
      diagnostics: [
        { line: 1, severity: 'error', message: '<img src=x onerror=alert(1)>\u{202E}ok' },
        { line: 2, severity: 'info', message: 'y'.repeat(900) },
      ],
    })
    const group = root.querySelector('[role="group"]')
    expect(group?.querySelector('img')).toBeNull()
    expect(group).toHaveTextContent('<img src=x onerror=alert(1)>⟨U+202E⟩ok')
    expect(group?.textContent).toContain(`${'y'.repeat(500)}…`)
    expect(group?.textContent).not.toContain('y'.repeat(501))
  })

  it('clamps a line outside the text to the last line', () => {
    const { root } = renderEditor({
      value,
      diagnostics: [{ line: 99, severity: 'error', message: 'late' }],
    })
    expect(Array.from(root.querySelectorAll('.cm-line'))[1]).toHaveClass('exdb-diag-line-error')
  })

  it('lists at most 50 findings and says how many more', () => {
    const many = Array.from(
      { length: 60 },
      (_, i): SqlDiagnostic => ({
        line: 1,
        severity: 'info',
        message: `note ${i}`,
      }),
    )
    const { root } = renderEditor({ value, diagnostics: many })
    const group = root.querySelector('[role="group"]')
    expect(group?.querySelectorAll('button')).toHaveLength(50)
    expect(group).toHaveTextContent('60 problems: 60 info')
    expect(group).toHaveTextContent('and 10 more')
  })

  it('says so when it marks only the first 200 findings', () => {
    const many = Array.from(
      { length: 250 },
      (_, i): SqlDiagnostic => ({
        line: 1,
        severity: 'warning',
        message: `note ${i}`,
      }),
    )
    const { root } = renderEditor({ value, diagnostics: many })
    const group = root.querySelector('[role="group"]')
    expect(group).toHaveTextContent(
      '250 problems (the first 200 are marked and counted): 200 warnings',
    )
    expect(group?.querySelectorAll('button')).toHaveLength(50)
    expect(group).toHaveTextContent('and 200 more')
  })
})

describe('SqlEditor: completion from the injected provider', () => {
  const provider = (
    items: Awaited<ReturnType<SqlCompletionProvider>> = [
      { label: 'users', kind: 'table', detail: 'public.users' },
      { label: 'user_roles', kind: 'table' },
    ],
  ) => vi.fn<SqlCompletionProvider>(async () => items)

  async function complete(props: Partial<SqlEditorProps>, value: string) {
    const view = renderEditor({ mode: 'draft', value, ...props })
    view.editor.focus()
    view.editor.dispatch({ selection: { anchor: value.length } })
    await act(async () => {
      startCompletion(view.editor)
    })
    return view
  }

  it('calls the provider with the word and the statement before it, and shows its labels', async () => {
    const completion = provider()
    const { root } = await complete({ completion }, 'select 1;\nselect * from us')
    await waitFor(() => expect(completion).toHaveBeenCalled())
    expect(completion).toHaveBeenCalledWith({ word: 'us', before: '\nselect * from ' })
    await waitFor(() => {
      const options = Array.from(root.querySelectorAll('.cm-tooltip-autocomplete [role="option"]'))
      expect(options.map((o) => o.textContent)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('users'),
          expect.stringContaining('user_roles'),
        ]),
      )
    })
    const list = root.querySelector('.cm-tooltip-autocomplete [role="listbox"]')
    expect(list).toHaveAttribute('aria-label', 'Suggestions')
    expect(root.querySelector('.cm-tooltip-autocomplete')).toHaveTextContent('public.users')
  })

  it('replaces only the part after the last dot', async () => {
    const completion = provider([{ label: 'users', kind: 'table' }])
    const { editor, root } = await complete({ completion }, 'select * from public.us')
    await waitFor(() =>
      expect(completion).toHaveBeenCalledWith({ word: 'public.us', before: 'select * from ' }),
    )
    await waitFor(() =>
      expect(root.querySelector('.cm-tooltip-autocomplete [role="option"]')).not.toBeNull(),
    )
    // Enter right after the list opens is ignored on purpose (a typing accident), so wait it out.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120))
    })
    fireEvent.keyDown(editor.contentDOM, { key: 'Enter' })
    expect(editor.state.doc.toString()).toBe('select * from public.users')
  })

  it('shows nothing, and logs nothing, when the provider fails', async () => {
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation(() => {}),
    )
    try {
      const failing = vi.fn<SqlCompletionProvider>(async () => {
        throw new Error('catalog unavailable: password=hunter2')
      })
      // No SQL keyword starts with "zzq", so the grammar offers nothing either.
      const { root } = await complete({ completion: failing }, 'select * from zzq')
      await waitFor(() => expect(failing).toHaveBeenCalled())
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
      expect(root.querySelector('[role="option"]')).toBeNull()
      expect(root.querySelector('.cm-tooltip-autocomplete')).toBeNull()
      expect(root.textContent).not.toContain('hunter2')
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })

  it('ignores a malformed answer', async () => {
    const odd = vi.fn(async () => 'not a list')
    // The provider type forbids this; the editor must not trust the type at run time.
    const { root } = await complete(
      { completion: odd as unknown as SqlCompletionProvider },
      'select * from zzq',
    )
    await waitFor(() => expect(odd).toHaveBeenCalled())
    expect(root.querySelector('[role="option"]')).toBeNull()
  })

  it('shows invisible characters of a label as code points', async () => {
    const completion = provider([{ label: 'ta\u{202E}ble', kind: 'table' }])
    const { root } = await complete({ completion }, 'select * from ta')
    await waitFor(() => expect(root.querySelector('[role="option"]')).not.toBeNull())
    const option = root.querySelector('[role="option"]')
    expect(option?.textContent).toContain('ta⟨U+202E⟩ble')
    expect(option?.textContent).not.toContain('\u{202E}')
  })

  it('does not ask inside a comment or a string literal', async () => {
    const completion = provider()
    await complete({ completion }, 'select 1 -- us')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(completion).not.toHaveBeenCalled()
    cleanup()
    await complete({ completion }, "select 'us")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(completion).not.toHaveBeenCalled()
  })

  it('does not complete in read-only mode', async () => {
    const completion = provider()
    const view = renderEditor({ mode: 'readonly', value: 'select * from us', completion })
    await act(async () => {
      startCompletion(view.editor)
    })
    expect(completion).not.toHaveBeenCalled()
  })

  it('uses the provider of the latest render', async () => {
    const first = provider()
    const second = provider([{ label: 'accounts', kind: 'table' }])
    const view = renderEditor({ value: 'select * from ac', completion: first })
    view.rerender(
      <SqlEditor value="select * from ac" mode="draft" label="Migration SQL" completion={second} />,
    )
    view.editor.focus()
    view.editor.dispatch({ selection: { anchor: 16 } })
    await act(async () => {
      startCompletion(view.editor)
    })
    await waitFor(() => expect(second).toHaveBeenCalled())
    expect(first).not.toHaveBeenCalled()
  })
})

describe('SqlEditor: content is data (C-26)', () => {
  it('keeps markup in the value as text', () => {
    const { root, container } = renderEditor({
      value: "select '<script>window.__pwned = 1</script>', '<img src=x onerror=alert(1)>'",
    })
    expect(root.querySelector('script')).toBeNull()
    expect(root.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(text(root)).toContain('<script>window.__pwned = 1</script>')
    expect(Reflect.get(window, '__pwned')).toBeUndefined()
  })

  it('shows direction and zero-width characters as code points with a spoken name', () => {
    const { root } = renderEditor({ value: 'select \u{202E}1\u{200B}, \u{0000}' })
    const hidden = Array.from(root.querySelectorAll('.exdb-hidden-char'))
    expect(hidden.map((el) => el.getAttribute('data-code-point'))).toEqual([
      'U+202E',
      'U+200B',
      'U+0000',
    ])
    expect(hidden[0]).toHaveTextContent('⟨U+202E⟩')
    expect(hidden[0]).toHaveTextContent('hidden character U+202E, right-to-left override')
    expect(hidden[0]?.querySelector('[aria-hidden="true"]')).toHaveTextContent('⟨U+202E⟩')
    expect(text(root)).not.toContain('\u{202E}')
  })

  it('shows characters that the default set misses too', () => {
    const { root } = renderEditor({ value: 'a\u{202A}b\u{2060}c\u{FE0F}d\u{E0041}e\u{115F}' })
    const ids = Array.from(root.querySelectorAll('.exdb-hidden-char')).map((el) =>
      el.getAttribute('data-code-point'),
    )
    expect(ids).toEqual(['U+202A', 'U+2060', 'U+FE0F', 'U+E0041', 'U+115F'])
  })

  it('underlines visible non-ASCII characters so a look-alike is not taken for ASCII', () => {
    const { root } = renderEditor({ value: 'select "аdmin"' })
    const marked = Array.from(root.querySelectorAll('.exdb-non-ascii')).map((el) => el.textContent)
    expect(marked).toEqual(['а'])
  })

  it('leaves tabs to the editor', () => {
    const { root } = renderEditor({ value: 'a\tb' })
    expect(root.querySelectorAll('.exdb-hidden-char')).toHaveLength(0)
  })
})

describe('SqlEditor: keyboard', () => {
  it('lets Tab leave the editor by default', () => {
    const { editor } = renderEditor({ value: 'a' })
    const proceeded = fireEvent.keyDown(editor.contentDOM, { key: 'Tab' })
    expect(proceeded).toBe(true)
    expect(editor.state.doc.toString()).toBe('a')
  })

  it('indents with Tab when the person turned it on, and Escape then Tab leaves', () => {
    const { editor } = renderEditor({ value: 'a', tabIndents: true })
    editor.focus()
    const first = fireEvent.keyDown(editor.contentDOM, { key: 'Tab' })
    expect(first).toBe(false)
    expect(editor.state.doc.toString()).toBe('  a')

    fireEvent.keyDown(editor.contentDOM, { key: 'Escape' })
    const leave = fireEvent.keyDown(editor.contentDOM, { key: 'Tab' })
    expect(leave).toBe(true)
    expect(editor.state.doc.toString()).toBe('  a')

    // Only the next Tab leaves; indentation is back after it.
    const again = fireEvent.keyDown(editor.contentDOM, { key: 'Tab' })
    expect(again).toBe(false)
  })

  it('cancels the escape when another key comes first', () => {
    const { editor } = renderEditor({ value: 'a', tabIndents: true })
    fireEvent.keyDown(editor.contentDOM, { key: 'Escape' })
    fireEvent.keyDown(editor.contentDOM, { key: 'ArrowRight' })
    expect(fireEvent.keyDown(editor.contentDOM, { key: 'Tab' })).toBe(false)
  })

  it('opens the search panel inside the shadow root, in sentence case', () => {
    const { root, editor } = renderEditor({ value: 'select 1' })
    act(() => {
      openSearchPanel(editor)
    })
    const panel = root.querySelector('.cm-search')
    expect(panel).not.toBeNull()
    expect(panel?.closest('.cm-editor')).not.toBeNull()
    const scope = within(panel as HTMLElement)
    expect(scope.getByRole('button', { name: 'Next match' })).toBeInTheDocument()
    expect(scope.getByRole('button', { name: 'Previous match' })).toBeInTheDocument()
    expect(scope.getByRole('textbox', { name: 'Find' })).toBeInTheDocument()
    expect(scope.getByRole('button', { name: 'Close' })).toBeInTheDocument()
    expect(document.querySelector('.cm-search')).toBeNull()
  })

  it('does not offer replace in read-only mode', () => {
    const { root, editor } = renderEditor({ mode: 'readonly', value: 'select 1' })
    act(() => {
      openSearchPanel(editor)
    })
    expect(root.querySelector('.cm-search [name="replace"]')).toBeNull()
  })
})

describe('SqlEditor: handle', () => {
  it('focuses, moves the cursor by line and column, and reads the selection', () => {
    const ref = createRef<EditorHandle>()
    const { root, editor } = renderEditor({ value: 'select 1;\nfrom t;', ref })
    const handle = ref.current
    expect(handle).not.toBeNull()
    handle?.focus()
    expect(root.activeElement).toBe(editor.contentDOM)

    handle?.setSelection(2, 3)
    expect(editor.state.selection.main.head).toBe(editor.state.doc.line(2).from + 2)
    expect(handle?.getSelectionText()).toBe('')

    editor.dispatch({ selection: { anchor: 0, head: 6 } })
    expect(handle?.getSelectionText()).toBe('select')
  })

  it('clamps a position outside the text', () => {
    const ref = createRef<EditorHandle>()
    const { editor } = renderEditor({ value: 'ab\ncd', ref })
    ref.current?.setSelection(99, 99)
    expect(editor.state.selection.main.head).toBe(5)
    ref.current?.setSelection(0, 0)
    expect(editor.state.selection.main.head).toBe(0)
  })

  it('works in read-only mode', () => {
    const ref = createRef<EditorHandle>()
    const { editor } = renderEditor({ mode: 'readonly', value: 'ab\ncd', ref })
    ref.current?.setSelection(2, 2)
    expect(editor.state.selection.main.head).toBe(4)
  })
})

describe('SqlEditor: accessibility', () => {
  it('has no axe violations in draft mode with findings', async () => {
    const { container } = renderEditor({
      value: 'select *\nselect x FORM t',
      diagnostics: [
        { line: 2, column: 10, severity: 'error', message: 'syntax error' },
        { line: 1, severity: 'warning', message: 'select * is not stable' },
      ],
    })
    expect(await axeViolations(container)).toEqual([])
  })

  it('has no axe violations in query and read-only mode', async () => {
    const query = renderEditor({ mode: 'query', value: 'select 1', onRun: () => {} })
    expect(await axeViolations(query.container)).toEqual([])
    cleanup()
    const readonly = renderEditor({ mode: 'readonly', value: 'select \u{202E}1' })
    expect(await axeViolations(readonly.container)).toEqual([])
  })

  it('has no axe violations with the search panel and a completion list open', async () => {
    const completion: SqlCompletionProvider = async () => [{ label: 'users', kind: 'table' }]
    const view = renderEditor({ value: 'select * from us', completion })
    view.editor.focus()
    view.editor.dispatch({ selection: { anchor: 16 } })
    await act(async () => {
      startCompletion(view.editor)
    })
    await waitFor(() => expect(view.root.querySelector('[role="option"]')).not.toBeNull())
    act(() => {
      openSearchPanel(view.editor)
    })
    expect(await axeViolations(view.container)).toEqual([])
  })
})
