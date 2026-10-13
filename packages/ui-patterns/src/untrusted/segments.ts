/**
 * Untrusted text made visible (C-26, ADR-0029 §4): SQL, object names,
 * comments, client names and log lines are shown as text, and every
 * character that changes what a reader sees without being seen itself is
 * shown by its code point instead of acting. The rules of the Wave 7 plan
 * review (`markedLine`), kept as a pure function so every surface that shows
 * foreign text uses the same ones.
 */
export type Segment =
  | { readonly kind: 'text'; readonly text: string }
  /** A tab, shown as an arrow so indentation tricks are visible. */
  | { readonly kind: 'tab' }
  /** A control, bidirectional, format or invisible character: shown as `⟨U+XXXX⟩`, never applied. */
  | { readonly kind: 'hidden'; readonly codePoint: number; readonly label: string }
  /** A visible character outside printable ASCII: shown, but marked (homoglyphs). */
  | { readonly kind: 'non-ascii'; readonly text: string; readonly codePoint: number }

/** Every default-ignorable, format or control character and the line and paragraph separators. */
const IGNORABLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}\p{Zl}\p{Zp}]/u

/**
 * Characters that change what a reader sees without being seen themselves:
 * control, bidi and format characters, line and paragraph separators, and the
 * invisible fillers (soft hyphen, Hangul and Khmer fillers, Mongolian
 * separators, variation selectors, tag characters). The Unicode properties
 * cover the whole classes (musical and shorthand format controls, prepended
 * concatenation marks, Egyptian hieroglyph format controls); the explicit
 * ranges keep the fillers that are letters by category.
 */
export function isInvisible(cp: number): boolean {
  return (
    IGNORABLE.test(String.fromCodePoint(cp)) ||
    cp < 0x20 ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0x00ad ||
    cp === 0x034f ||
    cp === 0x061c ||
    (cp >= 0x115f && cp <= 0x1160) ||
    (cp >= 0x17b4 && cp <= 0x17b5) ||
    (cp >= 0x180b && cp <= 0x180f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x2028 && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    cp === 0x3164 ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0xfeff ||
    cp === 0xffa0 ||
    (cp >= 0xfff0 && cp <= 0xfffb) ||
    (cp >= 0xe0000 && cp <= 0xe0fff)
  )
}

/** `⟨U+202E⟩` for a code point. */
export function codePointLabel(cp: number): string {
  return `⟨U+${cp.toString(16).toUpperCase().padStart(4, '0')}⟩`
}

/**
 * One line of untrusted text as segments: printable ASCII as text runs, a
 * tab as `tab`, every invisible, control or bidi character as `hidden`,
 * other non-ASCII characters as `non-ascii`. `marked` counts the hidden and
 * non-ASCII characters (the view says how many it marked).
 */
export function segmentLine(line: string): {
  readonly segments: readonly Segment[]
  readonly marked: number
} {
  const segments: Segment[] = []
  let plain = ''
  let marked = 0
  const flush = () => {
    if (plain.length > 0) segments.push({ kind: 'text', text: plain })
    plain = ''
  }
  for (const ch of line) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp === 0x09) {
      flush()
      segments.push({ kind: 'tab' })
    } else if (isInvisible(cp)) {
      flush()
      marked++
      segments.push({ kind: 'hidden', codePoint: cp, label: codePointLabel(cp) })
    } else if (cp > 0x7e) {
      flush()
      marked++
      segments.push({ kind: 'non-ascii', text: ch, codePoint: cp })
    } else {
      plain += ch
    }
  }
  flush()
  return { segments, marked }
}

/** Lines of a text, split on CRLF, LF and CR (a lone CR never hides a line). */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/)
}
