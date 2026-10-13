import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

/**
 * The look of the editors: only token custom properties (`var(--foreground)`
 * and so on), which inherit into the shadow tree, so light and dark follow the
 * page with no run-time code. No hex, no `rgba`; every text color is a token
 * the token package proves at 4.5:1 on the card surface.
 */

/** One line of text, in rem so it follows the person's font size. */
export const LINE_HEIGHT_REM = 1.375

const MONO =
  'var(--font-mono, "Source Code Pro", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace)'
const SANS =
  'var(--font-sans, "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif)'

const mix = (token: string, percent: number): string =>
  `color-mix(in oklab, var(${token}) ${percent}%, transparent)`

const SELECTION = mix('--primary', 18)

export const exdbHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--primary)', fontWeight: '500' },
  { tag: [t.string, t.special(t.string)], color: 'var(--success)' },
  { tag: [t.number, t.bool, t.null, t.integer, t.float], color: 'var(--warning)' },
  {
    tag: [t.comment, t.lineComment, t.blockComment],
    color: 'var(--muted-foreground)',
    fontStyle: 'italic',
  },
  { tag: [t.typeName, t.standard(t.name)], color: 'var(--info)' },
  { tag: t.special(t.name), color: 'var(--info)', fontStyle: 'italic' },
  {
    tag: [t.operator, t.punctuation, t.separator, t.paren, t.squareBracket, t.brace],
    color: 'var(--muted-foreground)',
  },
])

/** Syntax colors; `fallback` keeps the text readable if a tag has no rule. */
export const exdbSyntaxHighlighting = syntaxHighlighting(exdbHighlightStyle, { fallback: true })

/**
 * The theme of the SQL editor and of both sides of the diff. Selectors that
 * the base theme styles are repeated with the same specificity (the theme
 * comes later in the cascade); classes with an `exdb-` prefix belong to the
 * extensions of this folder.
 */
export const exdbEditorTheme = EditorView.theme({
  '&': {
    color: 'var(--foreground)',
    backgroundColor: 'var(--card)',
    fontFamily: MONO,
    fontSize: '0.8125rem',
    maxHeight: 'var(--exdb-editor-max-height, none)',
  },
  '&.cm-focused': { outline: '2px solid var(--ring)', outlineOffset: '-2px' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: `${LINE_HEIGHT_REM}rem`, overflow: 'auto' },
  '.cm-content, .cm-gutter': { minHeight: 'var(--exdb-editor-min-height, 4.125rem)' },
  '.cm-content': { caretColor: 'var(--foreground)', padding: '0.375rem 0' },
  '.cm-line': { padding: '0 0.75rem' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { background: SELECTION },
  // The active line is marked while the editor has focus; a display editor has no cursor line.
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-activeLine': { backgroundColor: 'var(--muted)' },
  '.cm-gutters': {
    backgroundColor: 'var(--muted)',
    color: 'var(--muted-foreground)',
    border: 'none',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-activeLineGutter': {
    backgroundColor: 'var(--accent)',
    color: 'var(--foreground)',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 0.5rem 0 0.75rem', minWidth: '2.5rem' },
  '&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket': {
    backgroundColor: 'var(--accent)',
    outline: '1px solid var(--border-stronger)',
  },
  '&.cm-focused .cm-nonmatchingBracket': { outlineColor: 'var(--destructive)' },
  // Matches are outlined, not filled: the syntax colors are only just above 4.5:1 on the card, so
  // any fill would take them below it, and an outline is a signal that is not color.
  '.cm-selectionMatch': {
    backgroundColor: 'transparent',
    outline: '1px dotted var(--border-stronger)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'transparent',
    outline: '1px solid var(--border-stronger)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'transparent',
    outline: '2px solid var(--primary-bright)',
  },
  '.cm-placeholder': { color: 'var(--muted-foreground)' },

  // Panels: search, and the list of problems.
  '.cm-panels': { backgroundColor: 'var(--muted)', color: 'var(--foreground)', fontFamily: SANS },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border-strong)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border-strong)' },
  '.cm-panel.cm-search': { padding: '0.375rem 1.75rem 0.375rem 0.75rem', fontSize: '0.75rem' },
  '.cm-panel.cm-search label': { fontSize: '0.75rem' },
  '.cm-panel.cm-search input.cm-textfield': {
    backgroundColor: 'var(--field)',
    color: 'var(--foreground)',
    border: '1px solid var(--border-control)',
    borderRadius: '0.25rem',
    padding: '0.125rem 0.375rem',
    fontFamily: 'inherit',
    fontSize: '0.75rem',
  },
  '.cm-panel.cm-search button.cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'var(--secondary)',
    color: 'var(--foreground)',
    border: '1px solid var(--border-control)',
    borderRadius: '0.25rem',
    padding: '0.125rem 0.5rem',
    fontFamily: 'inherit',
    fontSize: '0.75rem',
    cursor: 'pointer',
  },
  '.cm-panel.cm-search button.cm-button:hover': { backgroundColor: 'var(--accent)' },
  '.cm-panel.cm-search input:focus-visible, .cm-panel.cm-search button:focus-visible': {
    outline: '2px solid var(--ring)',
    outlineOffset: '1px',
  },
  '.cm-panel.cm-search [name=close]': {
    color: 'var(--foreground)',
    cursor: 'pointer',
    fontSize: '1rem',
  },

  // Completion tooltip.
  '.cm-tooltip': {
    backgroundColor: 'var(--popover)',
    color: 'var(--popover-foreground)',
    border: '1px solid var(--border-overlay)',
    borderRadius: '0.375rem',
    boxShadow: '0 4px 12px oklch(0 0 0 / 0.18)',
    fontFamily: MONO,
    fontSize: '0.8125rem',
  },
  // A short list that never scrolls: a scrolling list the editor's focus cannot enter is not
  // reachable as a scroll region, and the person narrows a long list by typing.
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'inherit', maxHeight: 'none' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '0.125rem 0.5rem' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--accent)',
    color: 'var(--accent-foreground)',
    outline: '1px solid var(--border-stronger)',
    outlineOffset: '-1px',
  },
  '.cm-tooltip-autocomplete .cm-completionDetail': { color: 'var(--muted-foreground)' },

  // Untrusted text made visible (C-26).
  '.exdb-hidden-char': {
    backgroundColor: 'var(--warning-200)',
    color: 'var(--warning-600)',
    border: '1px solid var(--warning-400)',
    borderRadius: '2px',
    padding: '0 2px',
    margin: '0 1px',
    fontSize: '0.85em',
  },
  '.exdb-non-ascii': {
    unicodeBidi: 'isolate',
    textDecoration: 'underline dotted',
    textDecorationColor: 'var(--warning)',
    textUnderlineOffset: '4px',
  },
  '.exdb-visually-hidden': {
    position: 'absolute',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
  },

  // Diagnostics: line, range, gutter marker, list.
  // Specific enough to win over the active line, so a finding stays tinted under the cursor.
  '&.cm-editor .cm-line.exdb-diag-line-error': { backgroundColor: 'var(--destructive-200)' },
  '&.cm-editor .cm-line.exdb-diag-line-warning': { backgroundColor: 'var(--warning-200)' },
  '&.cm-editor .cm-line.exdb-diag-line-info': { backgroundColor: mix('--info', 14) },
  '.exdb-diag-range': {
    textDecorationLine: 'underline',
    textDecorationStyle: 'wavy',
    textUnderlineOffset: '3px',
  },
  '.exdb-diag-range-error': { textDecorationColor: 'var(--destructive)' },
  '.exdb-diag-range-warning': { textDecorationColor: 'var(--warning)' },
  '.exdb-diag-range-info': { textDecorationColor: 'var(--info)' },
  '.exdb-diag-number::before': { marginRight: '0.25rem', fontWeight: '600' },
  '.exdb-diag-number-error::before': { content: '"✕"', color: 'var(--destructive)' },
  '.exdb-diag-number-warning::before': { content: '"▲"', color: 'var(--warning)' },
  '.exdb-diag-number-info::before': { content: '"◆"', color: 'var(--info)' },
  '.exdb-diag-panel': {
    padding: '0.375rem 0.75rem',
    maxHeight: '9rem',
    overflow: 'auto',
    fontSize: '0.8125rem',
  },
  '.exdb-diag-summary': { fontWeight: '600', margin: '0 0 0.25rem' },
  '.exdb-diag-list': { listStyle: 'none', margin: '0', padding: '0' },
  '.exdb-diag-item': {
    display: 'block',
    width: '100%',
    textAlign: 'start',
    background: 'none',
    border: '0',
    color: 'inherit',
    font: 'inherit',
    minHeight: '1.5rem',
    padding: '0.1875rem 0',
    cursor: 'pointer',
  },
  '.exdb-diag-item:hover': { textDecoration: 'underline' },
  '.exdb-diag-item:focus-visible': { outline: '2px solid var(--ring)', outlineOffset: '1px' },
  '.exdb-diag-severity': { fontWeight: '600' },
  '.exdb-diag-severity-error': { color: 'var(--destructive)' },
  '.exdb-diag-severity-warning': { color: 'var(--warning)' },
  '.exdb-diag-severity-info': { color: 'var(--info)' },
})

/**
 * The merge view's colors, replacing the hard-coded ones of the library:
 * removed lines and text use the destructive ramp, added ones the success ramp
 * (text of the `-600` step on the `-200` and `-300` steps is proven at 4.5:1).
 * Color is never the only signal: the change gutter carries a "-" or "+", the
 * changed text is underlined, and the library wraps changed text in `del` and
 * `ins` elements that assistive technology announces.
 */
export const exdbDiffTheme = EditorView.theme({
  '&.cm-merge-a .cm-changedLine, .cm-deletedChunk': { backgroundColor: 'var(--destructive-200)' },
  '&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine': {
    backgroundColor: 'var(--success-200)',
  },
  '&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText': {
    background:
      'linear-gradient(var(--destructive), var(--destructive)) bottom/100% 2px no-repeat var(--destructive-300)',
  },
  '&.cm-merge-b .cm-changedText': {
    background:
      'linear-gradient(var(--success), var(--success)) bottom/100% 2px no-repeat var(--success-300)',
  },
  '.cm-changeGutter': { width: '1.25rem', paddingLeft: '0' },
  '&.cm-merge-a .cm-changedLineGutter, .cm-deletedLineGutter': {
    background: 'var(--destructive-300)',
    color: 'var(--destructive-600)',
    textAlign: 'center',
    fontWeight: '600',
  },
  '&.cm-merge-b .cm-changedLineGutter': {
    background: 'var(--success-300)',
    color: 'var(--success-600)',
    textAlign: 'center',
    fontWeight: '600',
  },
  '&.cm-merge-a .cm-changedLineGutter::before, .cm-deletedLineGutter::before': {
    content: '"\\2212"',
  },
  '&.cm-merge-b .cm-changedLineGutter::before': { content: '"+"' },
  '.cm-collapsedLines': {
    color: 'var(--muted-foreground)',
    background: 'var(--muted)',
    fontFamily: SANS,
    fontSize: '0.75rem',
  },
})
