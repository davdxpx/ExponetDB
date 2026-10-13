import type { Extension } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  Direction,
  EditorView,
  highlightSpecialChars,
  MatchDecorator,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'
import { codePointId, codePointLabel, describeCodePoint, isInvisible } from '@exponetdb/ui-patterns'

/**
 * C-26 inside the editors: SQL is text from outside. Every control, direction,
 * format and invisible character is replaced by a visible `⟨U+XXXX⟩` label
 * (with a spoken description), and every visible non-ASCII character is
 * underlined with a dotted line so a look-alike letter is not taken for the
 * ASCII one. The rules are those of `@exponetdb/ui-patterns` (`isInvisible`),
 * so the editor and the read-only views agree.
 */

let cachedSource: string | undefined

/**
 * A regular-expression class for the characters `isInvisible` names, found
 * by scanning the Basic Multilingual Plane and the tag block once. Tab,
 * line feed and carriage return stay out: CodeMirror draws tabs by tab size
 * and never leaves a line break inside a line.
 */
function invisibleClass(): string {
  if (cachedSource !== undefined) return cachedSource
  const ranges: Array<[number, number]> = []
  const scan = (from: number, to: number) => {
    for (let cp = from; cp <= to; cp += 1) {
      if (cp === 0x09 || cp === 0x0a || cp === 0x0d || !isInvisible(cp)) continue
      const last = ranges[ranges.length - 1]
      if (last !== undefined && last[1] === cp - 1) last[1] = cp
      else ranges.push([cp, cp])
    }
  }
  scan(0, 0xffff)
  scan(0xe0000, 0xe0fff)
  const unicodeEscape = (cp: number) => `\\u{${cp.toString(16)}}`
  cachedSource = `[${ranges
    .map(([a, b]) => (a === b ? unicodeEscape(a) : `${unicodeEscape(a)}-${unicodeEscape(b)}`))
    .join('')}]`
  return cachedSource
}

/** The placeholder of one hidden character: a visible label and a spoken description. */
function renderHiddenCharacter(code: number): HTMLElement {
  const id = codePointId(code)
  const wrapper = document.createElement('span')
  wrapper.className = 'exdb-hidden-char'
  wrapper.setAttribute('data-code-point', id)
  const visible = document.createElement('span')
  visible.setAttribute('aria-hidden', 'true')
  visible.textContent = codePointLabel(code)
  const spoken = document.createElement('span')
  spoken.className = 'exdb-visually-hidden'
  spoken.textContent = ` hidden character ${id}, ${describeCodePoint(code)} `
  wrapper.append(visible, spoken)
  return wrapper
}

const NON_ASCII = /[\u{80}-\u{10ffff}]/gu
// Each non-ASCII character is its own left-to-right isolate: a letter of a right-to-left
// script cannot carry the digits and punctuation around it elsewhere (`1 /*x*/ + 99 --y`
// with Hebrew letters never reads as commented out), and the cursor follows the same order.
// `bidiIsolate` tells CodeMirror's cursor model; the `dir` attribute and the theme's
// `unicode-bidi: isolate` (`.exdb-non-ascii`) make the browser draw the same.
const nonAsciiMark = Decoration.mark({
  class: 'exdb-non-ascii',
  attributes: { dir: 'ltr' },
  bidiIsolate: Direction.LTR,
})

class NonAsciiPlugin {
  decorations: DecorationSet
  private readonly matcher = new MatchDecorator({
    regexp: NON_ASCII,
    decoration: () => nonAsciiMark,
  })

  constructor(view: EditorView) {
    this.decorations = this.matcher.createDeco(view)
  }

  update(update: ViewUpdate): void {
    this.decorations = this.matcher.updateDeco(update, this.decorations)
  }
}

const nonAsciiPlugin = ViewPlugin.fromClass(NonAsciiPlugin, {
  decorations: (plugin) => plugin.decorations,
})

/** Hidden characters shown as code points, and non-ASCII characters underlined. */
export function untrustedTextVisible(): Extension {
  return [
    highlightSpecialChars({
      specialChars: new RegExp(invisibleClass(), 'gu'),
      render: (code) => renderHiddenCharacter(code),
    }),
    nonAsciiPlugin,
    EditorView.bidiIsolatedRanges.of(
      (view) => view.plugin(nonAsciiPlugin)?.decorations ?? Decoration.none,
    ),
  ]
}
