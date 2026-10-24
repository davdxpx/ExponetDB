import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from '@codemirror/commands'
import { PostgreSQL, sql } from '@codemirror/lang-sql'
import { bracketMatching, indentOnInput, indentUnit } from '@codemirror/language'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Annotation, EditorState, type Extension, Prec } from '@codemirror/state'
import {
  type Command,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as placeholderExtension,
} from '@codemirror/view'

import { completionSources } from './cm-completion.ts'
import { diagnosticsExtension } from './cm-diagnostics.ts'
import { exdbEditorTheme, exdbSyntaxHighlighting } from './cm-theme.ts'
import { untrustedTextVisible } from './cm-untrusted.ts'
import type { SqlCompletionProvider, SqlEditorMode } from './types.ts'

/**
 * The CodeMirror configuration of `SqlEditor`: what never changes
 * (`staticExtensions`) and what follows the props (`dynamicExtensions`, held in
 * one compartment and rebuilt when `mode`, the label and the like change).
 * Nothing here runs SQL or sends text anywhere: the editor reports changes and
 * a run request through callbacks.
 */

/** Marks a transaction that applies a new `value` from outside, so it is not reported back as an edit. */
export const externalChange = Annotation.define<boolean>()

export interface EditorCallbacks {
  onChange(value: string): void
  onRun(): void
  /** The editor went from no selection to a selection or back. */
  onSelectionChange(hasSelection: boolean): void
  provider(): SqlCompletionProvider | undefined
}

export interface DynamicOptions {
  readonly mode: SqlEditorMode
  readonly label: string
  readonly placeholder: string | undefined
  readonly wrap: boolean
  readonly tabIndents: boolean
  readonly hasRun: boolean
}

/** CodeMirror's own words, in sentence case (US English); the others keep theirs. */
const PHRASES: Record<string, string> = {
  next: 'Next match',
  previous: 'Previous match',
  all: 'Select all matches',
  'match case': 'Match case',
  regexp: 'Regular expression',
  'by word': 'Whole word',
  replace: 'Replace',
  'replace all': 'Replace all',
  close: 'Close',
  Completions: 'Suggestions',
}

export function staticExtensions(idBase: string, callbacks: EditorCallbacks): Extension {
  // Per editor: whether the last update left text selected, so a cursor move is not reported.
  let hadSelection = false
  return [
    exdbEditorTheme,
    exdbSyntaxHighlighting,
    sql({ dialect: PostgreSQL, upperCaseKeywords: true }),
    lineNumbers(),
    highlightActiveLineGutter(),
    untrustedTextVisible(),
    drawSelection(),
    EditorState.allowMultipleSelections.of(true),
    EditorState.tabSize.of(2),
    indentUnit.of('  '),
    bracketMatching(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    diagnosticsExtension(idBase),
    EditorState.phrases.of(PHRASES),
    EditorView.updateListener.of((update) => {
      if (update.selectionSet || update.docChanged) {
        const hasSelection = update.state.selection.ranges.some((range) => !range.empty)
        if (hasSelection !== hadSelection) {
          hadSelection = hasSelection
          callbacks.onSelectionChange(hasSelection)
        }
      }
      if (!update.docChanged) return
      if (update.transactions.some((tr) => tr.annotation(externalChange) === true)) return
      callbacks.onChange(update.state.doc.toString())
    }),
  ]
}

/** Tab with indentation on: the indent unit at the cursor, or the selected lines indented. */
const indentOrInsert: Command = (view) => {
  const { state } = view
  if (state.selection.ranges.some((range) => !range.empty)) return indentMore(view)
  view.dispatch(
    state.update(state.replaceSelection(state.facet(indentUnit)), {
      scrollIntoView: true,
      userEvent: 'input',
    }),
  )
  return true
}

/**
 * Tab moves focus out of the editor unless the person turned indentation on
 * (WCAG 2.1.2, no keyboard trap). With it on, Escape (when nothing else used
 * it: a menu, the search panel, a selection) and then Tab leave the editor.
 */
function tabBehavior(tabIndents: boolean): Extension {
  if (!tabIndents) return []
  const state = { escaped: false }
  return [
    Prec.lowest(
      keymap.of([
        {
          key: 'Escape',
          run: () => {
            state.escaped = true
            return false
          },
        },
      ]),
    ),
    keymap.of([
      {
        key: 'Tab',
        run: (view) => {
          if (state.escaped) {
            state.escaped = false
            return false
          }
          return indentOrInsert(view)
        },
        shift: (view) => {
          if (state.escaped) {
            state.escaped = false
            return false
          }
          return indentLess(view)
        },
      },
    ]),
    // First in line, so no command that handles the key can hide it from this reset.
    Prec.highest(
      EditorView.domEventHandlers({
        keydown: (event) => {
          if (!['Escape', 'Tab', 'Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) {
            state.escaped = false
          }
          return false
        },
        blur: () => {
          state.escaped = false
          return false
        },
      }),
    ),
  ]
}

export function dynamicExtensions(options: DynamicOptions, callbacks: EditorCallbacks): Extension {
  const editable = options.mode !== 'readonly'
  return [
    EditorState.readOnly.of(!editable),
    EditorView.editable.of(editable),
    // In the tab order in every mode: a read-only editor is not editable, so it needs the place
    // itself, and a scrolling editor must have focusable content for keyboard users.
    EditorView.contentAttributes.of({ 'aria-label': options.label, tabindex: '0' }),
    options.wrap ? EditorView.lineWrapping : [],
    options.placeholder !== undefined && options.placeholder !== ''
      ? placeholderExtension(options.placeholder)
      : [],
    editable
      ? [
          history(),
          dropCursor(),
          indentOnInput(),
          closeBrackets(),
          autocompletion({
            override: completionSources(callbacks.provider),
            activateOnTypingDelay: 150,
            maxRenderedOptions: 12,
          }),
          options.mode === 'query' && options.hasRun
            ? Prec.highest(
                keymap.of([
                  {
                    key: 'Mod-Enter',
                    run: () => {
                      callbacks.onRun()
                      return true
                    },
                  },
                ]),
              )
            : [],
          tabBehavior(options.tabIndents),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap]),
        ]
      : keymap.of([...defaultKeymap, ...searchKeymap]),
  ]
}
