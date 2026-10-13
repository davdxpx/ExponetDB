import { defaultKeymap } from '@codemirror/commands'
import { PostgreSQL, sql } from '@codemirror/lang-sql'
import { bracketMatching } from '@codemirror/language'
import { type Chunk, goToNextChunk, goToPreviousChunk, MergeView } from '@codemirror/merge'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { EditorState, type Extension, type Text } from '@codemirror/state'
import { drawSelection, EditorView, keymap, lineNumbers } from '@codemirror/view'
import { Button, cn } from '@exponetdb/ui'
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react'

import {
  exdbDiffTheme,
  exdbEditorTheme,
  exdbSyntaxHighlighting,
  LINE_HEIGHT_REM,
} from './cm-theme.ts'
import { untrustedTextVisible } from './cm-untrusted.ts'
import { MAX_DIFF_CHARACTERS, type TextDiffViewProps } from './diff-types.ts'
import { untrustedMessage } from './text.ts'

/**
 * The text diff viewer (OD-40): CodeMirror's merge view, two read-only
 * editors side by side with the differences marked, mounted in a shadow root
 * like `SqlEditor` (constructable stylesheets, no `<style>` element). Load
 * this module lazily; the props are in `diff-types.ts`.
 *
 * Only the side-by-side layout is offered. The library's unified layout
 * draws removed lines as plain DOM text outside the editor, where a direction
 * override character would act (C-26); in the two editors every hidden
 * character is shown as a code point.
 *
 * Long unchanged runs are collapsed. The library's "N unchanged lines" bar is
 * a mouse target only, so a toolbar button shows every line (the view is
 * rebuilt) and buttons move between changes (WCAG 2.1.1).
 */

type HostStyle = CSSProperties & Record<`--exdb-${string}`, string>

const COLLAPSE = { margin: 3, minSize: 4 } as const
const PADDING_REM = 0.75

interface Summary {
  readonly changes: number
  /** Lines of the left text inside changed blocks. */
  readonly removed: number
  /** Lines of the right text inside changed blocks. */
  readonly added: number
  /** The diff gave up exactness (the texts differ too much); the blocks are approximate. */
  readonly approximate: boolean
}

const normalizeBreaks = (text: string): string => text.replace(/\r\n?/g, '\n')

function summarize(chunks: readonly Chunk[], a: Text, b: Text): Summary {
  let removed = 0
  let added = 0
  for (const chunk of chunks) {
    if (chunk.toA > chunk.fromA) {
      removed += a.lineAt(chunk.endA).number - a.lineAt(chunk.fromA).number + 1
    }
    if (chunk.toB > chunk.fromB) {
      added += b.lineAt(chunk.endB).number - b.lineAt(chunk.fromB).number + 1
    }
  }
  return {
    changes: chunks.length,
    removed,
    added,
    approximate: chunks.some((chunk) => !chunk.precise),
  }
}

const lines = (n: number): string => `${n} ${n === 1 ? 'line' : 'lines'}`

function describe(summary: Summary, beforeLabel: string, afterLabel: string): string {
  if (summary.changes === 0) return 'No differences'
  const blocks = `${summary.changes} changed ${summary.changes === 1 ? 'block' : 'blocks'}`
  const detail = `${beforeLabel}: ${lines(summary.removed)}, ${afterLabel}: ${lines(summary.added)}`
  return `${blocks} (${detail})${summary.approximate ? '; approximate, the texts differ too much for an exact comparison' : ''}`
}

function sideExtensions(label: string, language: boolean, wrap: boolean): Extension {
  return [
    exdbEditorTheme,
    exdbDiffTheme,
    exdbSyntaxHighlighting,
    language ? sql({ dialect: PostgreSQL }) : [],
    lineNumbers(),
    untrustedTextVisible(),
    drawSelection(),
    bracketMatching(),
    highlightSelectionMatches(),
    search({ top: true }),
    EditorState.readOnly.of(true),
    EditorState.tabSize.of(2),
    EditorView.editable.of(false),
    EditorView.contentAttributes.of({ 'aria-label': label, tabindex: '0' }),
    EditorState.phrases.of({
      '$ unchanged lines': '$ unchanged lines hidden',
      next: 'Next match',
      previous: 'Previous match',
      all: 'Select all matches',
      'match case': 'Match case',
      regexp: 'Regular expression',
      'by word': 'Whole word',
      close: 'Close',
    }),
    wrap ? EditorView.lineWrapping : [],
    keymap.of([...defaultKeymap, ...searchKeymap]),
  ]
}

export function TextDiffView({
  label,
  before,
  after,
  beforeLabel = 'Before',
  afterLabel = 'After',
  sql: highlightSql = true,
  collapseUnchanged = true,
  wrap = true,
  maxLines = 40,
  className,
}: TextDiffViewProps): ReactNode {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<MergeView | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [showAll, setShowAll] = useState(false)

  const leftLabel = untrustedMessage(beforeLabel, 80)
  const rightLabel = untrustedMessage(afterLabel, 80)
  const tooLarge = before.length > MAX_DIFF_CHARACTERS || after.length > MAX_DIFF_CHARACTERS
  const collapsed = collapseUnchanged && !showAll && before !== after

  useEffect(() => {
    const host = hostRef.current
    if (host === null || tooLarge) return
    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    const mount = document.createElement('div')
    root.append(mount)
    const view = new MergeView({
      a: {
        doc: normalizeBreaks(before),
        extensions: sideExtensions(`${leftLabel}, read-only text`, highlightSql, wrap),
      },
      b: {
        doc: normalizeBreaks(after),
        extensions: sideExtensions(`${rightLabel}, read-only text`, highlightSql, wrap),
      },
      parent: mount,
      // The editors are built before `mount` is in the shadow root, so the root has to be named.
      root,
      gutter: true,
      highlightChanges: true,
      collapseUnchanged: collapsed ? COLLAPSE : undefined,
      diffConfig: { scanLimit: 500, timeout: 500 },
    })
    view.dom.style.maxHeight = `${Math.max(1, maxLines) * LINE_HEIGHT_REM + PADDING_REM}rem`
    viewRef.current = view
    setSummary(summarize(view.chunks, view.a.state.doc, view.b.state.doc))
    return () => {
      viewRef.current = null
      view.destroy()
      mount.remove()
    }
  }, [before, after, leftLabel, rightLabel, highlightSql, wrap, maxLines, tooLarge, collapsed])

  const step = (command: typeof goToNextChunk) => {
    const view = viewRef.current
    if (view !== null) command(view.b)
  }
  const none = summary !== null && summary.changes === 0
  const hostStyle: HostStyle = { '--exdb-editor-min-height': '1.5rem' }

  return (
    <fieldset
      data-exdb-diff=""
      className={cn('m-0 flex min-w-0 flex-col gap-2 border-0 p-0', className)}
    >
      <legend className="p-0 text-sm font-medium text-foreground">{label}</legend>
      <div className="flex flex-wrap items-center gap-2">
        <p role="status" className="text-xs text-foreground-light">
          {tooLarge
            ? 'Too large to compare here'
            : summary === null
              ? 'Comparing'
              : describe(summary, leftLabel, rightLabel)}
        </p>
        {tooLarge ? null : (
          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="tiny"
              disabled={summary === null || none}
              onClick={() => step(goToPreviousChunk)}
            >
              Previous change
            </Button>
            <Button
              type="button"
              variant="outline"
              size="tiny"
              disabled={summary === null || none}
              onClick={() => step(goToNextChunk)}
            >
              Next change
            </Button>
            {collapseUnchanged && !none ? (
              <Button
                type="button"
                variant="outline"
                size="tiny"
                aria-pressed={showAll}
                onClick={() => setShowAll((value) => !value)}
              >
                Show all lines
              </Button>
            ) : null}
          </div>
        )}
      </div>
      {tooLarge ? (
        <p className="rounded-md border border-warning-400 bg-warning-200 px-3 py-2 text-sm text-foreground">
          {`Each side can hold at most ${MAX_DIFF_CHARACTERS.toLocaleString('en-US')} characters. ${leftLabel} has ${before.length.toLocaleString('en-US')}, ${rightLabel} has ${after.length.toLocaleString('en-US')}. Compare the files outside the browser.`}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[40rem]">
            <div
              aria-hidden="true"
              className="grid grid-cols-2 rounded-t-md border border-b-0 border-control bg-muted text-xs font-medium text-foreground-light"
            >
              <span className="truncate px-3 py-1">{leftLabel}</span>
              <span className="truncate border-l border-border px-3 py-1">{rightLabel}</span>
            </div>
            <div
              ref={hostRef}
              data-exdb-editor="diff"
              style={hostStyle}
              className="block w-full min-w-0 overflow-hidden rounded-b-md border border-control bg-card focus-within:border-control-hover"
            />
          </div>
        </div>
      )}
    </fieldset>
  )
}
