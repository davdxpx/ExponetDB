/**
 * Terminal-safe text ([`15-cli/README.md` §7](../../../../exponetdb-docs/15-cli/README.md#7-terminal-safety)).
 * Every remote string is untrusted: names, notes, messages, error details,
 * SQL and catalog text may carry escape sequences that move the cursor,
 * set the window title, write to the clipboard (OSC 52) or show a link that
 * points elsewhere (OSC 8), and bidirectional controls that reorder what a
 * person reads. `clean` removes all of them before anything is printed;
 * it changes only what is shown, never stored data.
 */

// ESC-introduced sequences: CSI (ESC [ … final), OSC (ESC ] … BEL or ST),
// DCS/SOS/PM/APC (ESC P|X|^|_ … ST), and two-byte ESC sequences.
const ESCAPES =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control sequences is the purpose
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b[\]PX^_][\s\S]*?(?:\u0007|\u001b\\|$)|\u001b[ -~]?/g
// 8-bit C1 introducers (CSI U+009B, OSC U+009D, DCS U+0090, …) and their payloads.
const C1_SEQUENCES =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control sequences is the purpose
  /[\u009b][0-?]*[ -/]*[@-~]|[\u0090\u0098\u009d\u009e\u009f][\s\S]*?(?:\u0007|\u009c|$)/g
// Remaining C0 (except tab and newline), DEL and C1 controls.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the purpose
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
// Bidirectional embeddings, overrides and isolates, and the marks that steer them.
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/** The text with every control and steering sequence removed; newlines and tabs kept. */
export function clean(value: string): string {
  return value
    .replace(ESCAPES, '')
    .replace(C1_SEQUENCES, '')
    .replace(CONTROLS, '')
    .replace(BIDI, '')
}

/** One line: cleaned, with newlines and tabs as spaces. */
export function cleanLine(value: string): string {
  return clean(value).replace(/[\t\n]+/g, ' ')
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Whether a code point is shown two columns wide (East Asian wide and fullwidth, emoji). */
function wide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
}

/** The display width of one grapheme cluster. */
function graphemeWidth(g: string): number {
  const cp = g.codePointAt(0) ?? 0
  // Combining marks and zero-width characters on their own take no column.
  if (/^[\p{M}\u200b-\u200d]+$/u.test(g)) return 0
  if (g.includes('\ufe0f') || wide(cp)) return 2
  return 1
}

/** The number of terminal columns `value` takes (graphemes, wide characters). */
export function width(value: string): number {
  let n = 0
  for (const { segment } of segmenter.segment(value)) n += graphemeWidth(segment)
  return n
}

/** `value` cut to at most `columns` display columns, with `…` (or `~` in ASCII) when cut. */
export function truncate(value: string, columns: number, ascii = false): string {
  if (width(value) <= columns) return value
  const mark = ascii ? '~' : '…'
  if (columns <= 1) return columns === 1 ? mark : ''
  let out = ''
  let used = 0
  for (const { segment } of segmenter.segment(value)) {
    const w = graphemeWidth(segment)
    if (used + w > columns - 1) break
    out += segment
    used += w
  }
  return out + mark
}

/** `value` padded with spaces to `columns` display columns. */
export function pad(value: string, columns: number): string {
  const w = width(value)
  return w >= columns ? value : value + ' '.repeat(columns - w)
}
