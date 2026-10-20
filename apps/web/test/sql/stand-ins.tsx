import type { Ref } from 'react'

/**
 * Stand-ins for the two lazy chunks of the SQL page, shared by its tests. The
 * editor (CodeMirror 6 in a shadow root) and the grid (TanStack) are tested in
 * `packages/ui-data`; here a text area and a small block stand in and record
 * what the page gives them. Use them in a test file with
 *
 *   vi.mock('@exponetdb/ui-data/editor/sql-editor', async () =>
 *     (await import('./stand-ins.tsx')).editorModule())
 *   vi.mock('@exponetdb/ui-data/grid/data-grid', async () =>
 *     (await import('./stand-ins.tsx')).gridModule())
 *
 * The text area keeps its own selection, so a test sets it with
 * `area.setSelectionRange(from, to)` and `fireEvent.select(area)`.
 */
interface StandInHandle {
  focus(): void
  setSelection(): void
  getSelectionText(): string
  getCursorOffset(): number
  getSelectionRanges(): readonly { from: number; to: number }[]
  replaceRange(from: number, to: number, expected: string, insert: string): boolean
}

interface StandInEditorProps {
  value: string
  onChange?: (value: string) => void
  mode: string
  label: string
  diagnostics?: readonly { line: number; severity: string; message: string }[]
  onRun?: () => void
  onSelectionChange?: (hasSelection: boolean) => void
  ref?: Ref<StandInHandle>
}

export async function editorModule() {
  const React = await import('react')
  return {
    SqlEditor: (props: StandInEditorProps) => {
      const area = React.useRef<HTMLTextAreaElement | null>(null)
      const had = React.useRef(false)
      const latest = React.useRef(props)
      latest.current = props
      React.useImperativeHandle(props.ref, () => ({
        focus() {},
        setSelection() {},
        getSelectionText() {
          const el = area.current
          return el === null ? '' : el.value.slice(el.selectionStart, el.selectionEnd)
        },
        getCursorOffset() {
          return area.current?.selectionEnd ?? 0
        },
        getSelectionRanges() {
          const el = area.current
          return el === null || el.selectionStart === el.selectionEnd
            ? []
            : [{ from: el.selectionStart, to: el.selectionEnd }]
        },
        replaceRange(from: number, to: number, expected: string, insert: string) {
          const el = area.current
          if (el === null || el.value.slice(from, to) !== expected) return false
          latest.current.onChange?.(`${el.value.slice(0, from)}${insert}${el.value.slice(to)}`)
          return true
        },
      }))
      return React.createElement('textarea', {
        ref: area,
        'aria-label': props.label,
        'data-mode': props.mode,
        'data-diagnostics': JSON.stringify(props.diagnostics ?? []),
        value: props.value,
        onChange: (event: { target: { value: string } }) => props.onChange?.(event.target.value),
        onSelect: (event: { currentTarget: HTMLTextAreaElement }) => {
          const el = event.currentTarget
          const now = el.selectionStart !== el.selectionEnd
          if (now !== had.current) {
            had.current = now
            props.onSelectionChange?.(now)
          }
        },
        onKeyDown: (event: {
          key: string
          ctrlKey: boolean
          metaKey: boolean
          preventDefault(): void
        }) => {
          if (
            (event.ctrlKey || event.metaKey) &&
            event.key === 'Enter' &&
            props.onRun !== undefined
          ) {
            event.preventDefault()
            props.onRun()
          }
        },
      })
    },
  }
}

export async function gridModule() {
  const React = await import('react')
  return {
    DataGrid: (props: {
      columns: readonly { name: string; masked?: boolean }[]
      rows: { state: string; value?: readonly unknown[] }
      truncated?: { reason: string }
    }) =>
      React.createElement(
        'div',
        {
          'data-testid': 'grid',
          'data-state': props.rows.state,
          'data-masked': props.columns.filter((c) => c.masked === true).length,
        },
        `${props.columns.length} columns, ${props.rows.value?.length ?? 0} rows`,
      ),
  }
}
