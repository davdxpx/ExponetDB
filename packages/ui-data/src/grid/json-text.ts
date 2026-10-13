/**
 * Compact and indented views of JSON text without parsing it into values: a
 * number such as `12345678901234567890` or `1e400` keeps its exact digits, a
 * duplicate key stays, and nothing is reordered. Strings are copied as they
 * are, so only whitespace outside strings changes.
 */

function isJsonSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}

/**
 * The text without whitespace outside strings, cut once it holds `limit` UTF-16
 * units (the caller cuts the rest by code points). `cut` says the text went on.
 * Text that is not JSON is passed through the same scan and stays text.
 */
export function compactJson(text: string, limit: number): { head: string; cut: boolean } {
  const out: string[] = []
  let size = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    if (size >= limit) return { head: out.join(''), cut: true }
    const ch = text.charAt(index)
    if (inString) {
      out.push(ch)
      size += 1
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (isJsonSpace(ch)) continue
    if (ch === '"') inString = true
    out.push(ch)
    size += 1
  }
  return { head: out.join(''), cut: false }
}

/** Above this many UTF-16 units a JSON text is shown as it is, not re-indented. */
export const PRETTY_JSON_LIMIT = 200_000

/**
 * JSON text indented by two spaces for reading, digits and strings untouched.
 * Only valid JSON is re-indented; anything else (or a very long text) is
 * returned as it is, so this never invents structure.
 */
export function prettyJson(text: string): string {
  if (text.length > PRETTY_JSON_LIMIT) return text
  try {
    JSON.parse(text)
  } catch {
    return text
  }
  const out: string[] = []
  let depth = 0
  let inString = false
  let escaped = false
  const newline = (): string => `\n${'  '.repeat(depth)}`
  for (let index = 0; index < text.length; index += 1) {
    const ch = text.charAt(index)
    if (inString) {
      out.push(ch)
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (isJsonSpace(ch)) continue
    if (ch === '"') {
      inString = true
      out.push(ch)
    } else if (ch === '{' || ch === '[') {
      // An empty object or array stays `{}` / `[]`.
      let next = index + 1
      while (next < text.length && isJsonSpace(text.charAt(next))) next += 1
      const close = ch === '{' ? '}' : ']'
      if (text.charAt(next) === close) {
        out.push(ch, close)
        index = next
      } else {
        depth += 1
        out.push(ch, newline())
      }
    } else if (ch === '}' || ch === ']') {
      depth -= 1
      out.push(newline(), ch)
    } else if (ch === ',') {
      out.push(ch, newline())
    } else if (ch === ':') {
      out.push(': ')
    } else {
      out.push(ch)
    }
  }
  return out.join('')
}
