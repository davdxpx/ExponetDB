import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { cn } from '@exponetdb/ui'
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react'

import { locate, setDiagnostics } from './cm-diagnostics.ts'
import {
  type DynamicOptions,
  dynamicExtensions,
  type EditorCallbacks,
  externalChange,
  staticExtensions,
} from './cm-sql-extensions.ts'
import { LINE_HEIGHT_REM } from './cm-theme.ts'
import { minimalChange, sameDiagnostics } from './text.ts'
import type { EditorHandle, SqlDiagnostic, SqlEditorProps } from './types.ts'

/**
 * The SQL editor (OD-32): CodeMirror 6 mounted in an open shadow root, so its
 * style rules are adopted constructable stylesheets of that root and the page
 * keeps `style-src 'self'` with no `<style>` element, no inline style and no
 * `blob:` worker. Load this module lazily (`React.lazy`); the types are in
 * `types.ts`.
 *
 * The editor never executes anything: `onRun` is a callback the caller
 * answers. The text is data (C-26): hidden and direction characters are shown
 * as code points, non-ASCII characters are underlined, nothing is ever passed
 * to `innerHTML`.
 */

type HostStyle = CSSProperties & Record<`--exdb-${string}`, string>

const NO_DIAGNOSTICS: readonly SqlDiagnostic[] = []
/** Content padding of the editor (top plus bottom), in rem, added to the line heights. */
const PADDING_REM = 0.75

const normalizeBreaks = (text: string): string => text.replace(/\r\n?/g, '\n')

function heightStyle(minLines: number, maxLines: number | undefined): HostStyle {
  const lines = (n: number) => `${Math.max(1, Math.trunc(n)) * LINE_HEIGHT_REM + PADDING_REM}rem`
  return maxLines === undefined
    ? { '--exdb-editor-min-height': lines(minLines) }
    : {
        '--exdb-editor-min-height': lines(minLines),
        '--exdb-editor-max-height': lines(Math.max(minLines, maxLines)),
      }
}

export function SqlEditor({
  value,
  onChange,
  mode,
  diagnostics,
  completion,
  onRun,
  label,
  minLines = 3,
  maxLines,
  placeholder,
  wrap = false,
  tabIndents = false,
  className,
  ref,
}: SqlEditorProps): ReactNode {
  const idBase = useId()
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const compartment = useMemo(() => new Compartment(), [])

  const options: DynamicOptions = {
    mode,
    label,
    placeholder,
    wrap,
    tabIndents,
    hasRun: onRun !== undefined,
  }
  const optionsKey = JSON.stringify(options)

  // What the editor needs at the moment of an event or of its creation, kept current after every render.
  const latest = useRef({ value, onChange, onRun, completion, options })
  useEffect(() => {
    latest.current = { value, onChange, onRun, completion, options }
  })
  const callbacks = useMemo<EditorCallbacks>(
    () => ({
      onChange: (text) => latest.current.onChange?.(text),
      onRun: () => latest.current.onRun?.(),
      provider: () => latest.current.completion,
    }),
    [],
  )

  // What the editor was last configured with, to skip a reconfiguration that changes nothing.
  const applied = useRef({ key: '', diagnostics: NO_DIAGNOSTICS })

  // The editor is created once; every later prop reaches it through the effects below.
  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    const mount = document.createElement('div')
    root.append(mount)
    const now = latest.current
    const view = new EditorView({
      state: EditorState.create({
        doc: normalizeBreaks(now.value),
        extensions: [
          staticExtensions(idBase, callbacks),
          compartment.of(dynamicExtensions(now.options, callbacks)),
        ],
      }),
      parent: mount,
      // Named even though the mount point is already in the root: a view built before its parent
      // is attached would fall back to the document and add a <style> element to it.
      root,
    })
    viewRef.current = view
    applied.current = { key: JSON.stringify(now.options), diagnostics: NO_DIAGNOSTICS }
    return () => {
      viewRef.current = null
      view.destroy()
      mount.remove()
    }
  }, [idBase, callbacks, compartment])

  useEffect(() => {
    const view = viewRef.current
    if (view === null || applied.current.key === optionsKey) return
    applied.current.key = optionsKey
    view.dispatch({
      effects: compartment.reconfigure(dynamicExtensions(latest.current.options, callbacks)),
    })
  }, [optionsKey, compartment, callbacks])

  useEffect(() => {
    const view = viewRef.current
    if (view === null) return
    const change = minimalChange(view.state.doc.toString(), normalizeBreaks(value))
    if (change !== null) view.dispatch({ changes: change, annotations: externalChange.of(true) })
  }, [value])

  useEffect(() => {
    const view = viewRef.current
    const next = diagnostics ?? NO_DIAGNOSTICS
    if (view === null || sameDiagnostics(applied.current.diagnostics, next)) return
    applied.current.diagnostics = next
    view.dispatch({ effects: setDiagnostics.of(next) })
  }, [diagnostics])

  useImperativeHandle(
    ref,
    (): EditorHandle => ({
      focus() {
        viewRef.current?.focus()
      },
      setSelection(line, column) {
        const view = viewRef.current
        if (view === null) return
        const at = locate(view.state.doc, line, column)
        view.dispatch({
          selection: { anchor: at },
          effects: EditorView.scrollIntoView(at, { y: 'center' }),
        })
      },
      getSelectionText() {
        const view = viewRef.current
        if (view === null) return ''
        return view.state.selection.ranges
          .filter((range) => !range.empty)
          .map((range) => view.state.sliceDoc(range.from, range.to))
          .join('\n')
      },
    }),
    [],
  )

  return (
    <div
      ref={hostRef}
      data-exdb-editor="sql"
      data-mode={mode}
      style={heightStyle(minLines, maxLines)}
      className={cn(
        'block w-full min-w-0 overflow-hidden rounded-md border border-control bg-card focus-within:border-control-hover',
        className,
      )}
    />
  )
}
