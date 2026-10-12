/**
 * A strict reading of a JSON request body before it is parsed: syntax,
 * nesting depth, number of values and duplicate object keys (two parsers
 * that keep different duplicates, an intermediary and the server, could
 * disagree on which tool runs). Linear in the length of the text; no value
 * is built here.
 */
export type JsonCheck =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: 'syntax' | 'depth' | 'elements' | 'duplicate_key' }

const WS = new Set([' ', '\t', '\n', '\r'])

export function readJson(
  text: string,
  limits: { readonly depth: number; readonly elements: number },
): JsonCheck {
  let i = 0
  let elements = 0
  const fail = (reason: 'syntax' | 'depth' | 'elements' | 'duplicate_key') =>
    ({ ok: false, reason }) as const
  const skip = () => {
    while (i < text.length && WS.has(text[i] ?? '')) i++
  }
  const string = (): string | undefined => {
    if (text[i] !== '"') return undefined
    const start = i
    i++
    while (i < text.length) {
      const ch = text[i]
      if (ch === '"') {
        i++
        try {
          return JSON.parse(text.slice(start, i)) as string
        } catch {
          return undefined
        }
      }
      if (ch === '\\') {
        i += 2
        continue
      }
      if (ch !== undefined && ch.charCodeAt(0) < 0x20) return undefined
      i++
    }
    return undefined
  }
  // An explicit stack instead of recursion: depth is bounded by the limit, not the call stack.
  type Frame = { readonly kind: 'object'; readonly keys: Set<string> } | { readonly kind: 'array' }
  const stack: Frame[] = []
  const scalar = (): boolean => {
    const rest = text.slice(i, i + 5)
    if (rest.startsWith('true')) {
      i += 4
      return true
    }
    if (rest.startsWith('false')) {
      i += 5
      return true
    }
    if (rest.startsWith('null')) {
      i += 4
      return true
    }
    const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(i, i + 400))
    if (m === null) return false
    i += m[0].length
    return true
  }
  skip()
  let expectValue = true
  for (;;) {
    if (expectValue) {
      skip()
      elements++
      if (elements > limits.elements) return fail('elements')
      const ch = text[i]
      if (ch === '{' || ch === '[') {
        i++
        if (stack.length >= limits.depth) return fail('depth')
        stack.push(ch === '{' ? { kind: 'object', keys: new Set() } : { kind: 'array' })
        skip()
        const close = ch === '{' ? '}' : ']'
        if (text[i] === close) {
          i++
          stack.pop()
          expectValue = false
        } else if (ch === '{') {
          // first key
          const frame = stack[stack.length - 1]
          const key = string()
          if (key === undefined || frame?.kind !== 'object') return fail('syntax')
          frame.keys.add(key)
          skip()
          if (text[i] !== ':') return fail('syntax')
          i++
          expectValue = true
          continue
        } else {
          expectValue = true
          continue
        }
      } else if (ch === '"') {
        if (string() === undefined) return fail('syntax')
        expectValue = false
      } else if (!scalar()) {
        return fail('syntax')
      } else {
        expectValue = false
      }
    }
    // after a value
    skip()
    const frame = stack[stack.length - 1]
    if (frame === undefined) {
      if (i !== text.length) return fail('syntax')
      break
    }
    const ch = text[i]
    if (ch === ',') {
      i++
      skip()
      if (frame.kind === 'object') {
        const key = string()
        if (key === undefined) return fail('syntax')
        if (frame.keys.has(key)) return fail('duplicate_key')
        frame.keys.add(key)
        skip()
        if (text[i] !== ':') return fail('syntax')
        i++
      }
      expectValue = true
    } else if ((ch === '}' && frame.kind === 'object') || (ch === ']' && frame.kind === 'array')) {
      i++
      stack.pop()
      expectValue = false
    } else {
      return fail('syntax')
    }
  }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return fail('syntax')
  }
}
