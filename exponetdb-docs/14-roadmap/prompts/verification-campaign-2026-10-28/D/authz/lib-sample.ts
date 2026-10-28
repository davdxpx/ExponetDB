/**
 * A tiny sampler for "valid-shaped" requests: walks the JSON Schema of a route
 * (input side) and builds the smallest value that satisfies it. Entity ids
 * (`^xxx_[0-7][0-9A-HJKMNP-TV-Z]{25}$`) become the placeholder `@id:xxx`; the
 * harness replaces a placeholder with a fixture id or a well-formed fake one.
 * Returns undefined when it cannot satisfy a constraint (the row is then
 * `needs-body` and the harness skips it unless `bodies.json` supplies one).
 */
type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
type Schema = Record<string, any>

const ULID = /^\^([a-z]{3,4})_\[0-7\]\[0-9A-HJKMNP-TV-Z\]\{25\}\$$/

/** Smallest string for the regex subset used by the contracts; undefined when unsupported. */
export function fromPattern(pattern: string): string | undefined {
  const id = ULID.exec(pattern)
  if (id?.[1] !== undefined) return `@id:${id[1]}`
  if (pattern === '^[0-7][0-9A-HJKMNP-TV-Z]{25}$') return '@id:ulid'
  let i = 0
  const src = pattern.replace(/^\^/, '').replace(/\$$/, '')
  function atom(): string | undefined {
    const ch = src[i]
    if (ch === undefined) return undefined
    if (ch === '(') {
      i++
      if (src.startsWith('?:', i)) i += 2
      const first = alt()
      if (src[i] !== ')') return undefined
      i++
      return first
    }
    if (ch === '[') {
      const end = src.indexOf(']', i + 2)
      if (end < 0) return undefined
      const body = src.slice(i + 1, end)
      i = end + 1
      if (body.startsWith('^')) return /^[^\\]*$/.test(body) ? 'a' : undefined
      const m = /^(\\.|.)/.exec(body)
      const first = m?.[1] ?? 'a'
      return first.startsWith('\\') ? first.slice(1) : first
    }
    if (ch === '\\') {
      const n = src[i + 1]
      i += 2
      if (n === 'd') return '1'
      if (n === 'S' || n === 'w') return 'a'
      if (n === 's') return ' '
      if (n === 'p' || n === 'P') return undefined
      return n
    }
    if (ch === '.') {
      i++
      return 'a'
    }
    if (ch === '|' || ch === ')') return undefined
    i++
    return ch
  }
  function seq(): string | undefined {
    let out = ''
    while (i < src.length && src[i] !== '|' && src[i] !== ')') {
      const a = atom()
      if (a === undefined) return undefined
      let n = 1
      const q = src[i]
      if (q === '?' || q === '*') {
        n = 0
        i++
      } else if (q === '+') {
        i++
      } else if (q === '{') {
        const end = src.indexOf('}', i)
        const m = /^(\d+)(?:,(\d*))?$/.exec(src.slice(i + 1, end))
        if (m === null) return undefined
        n = Number(m[1])
        i = end + 1
      }
      out += a.repeat(n)
    }
    return out
  }
  function alt(): string | undefined {
    let best = seq()
    while (src[i] === '|') {
      i++
      const other = seq()
      if (best === undefined || (other !== undefined && other.length < best.length)) best = other
    }
    return best
  }
  const out = alt()
  return i === src.length ? out : undefined
}

export function sample(root: Schema): Json | undefined {
  const defs: Schema = root['$defs'] ?? {}
  const walk = (s: Schema, stack: string[]): Json | undefined => {
    if (s === undefined || s === true) return null
    if (s['$ref'] !== undefined) {
      const name = String(s['$ref']).replace('#/$defs/', '')
      if (stack.includes(name)) return undefined
      return walk(defs[name] ?? {}, [...stack, name])
    }
    if ('const' in s) return s['const']
    if (Array.isArray(s['enum'])) return s['enum'][0] ?? undefined
    for (const k of ['anyOf', 'oneOf']) {
      if (Array.isArray(s[k])) {
        for (const alt of s[k]) {
          const v = walk(alt, stack)
          if (v !== undefined) return v
        }
        return undefined
      }
    }
    if (Array.isArray(s['allOf'])) {
      const merged: Schema = {}
      for (const part of s['allOf']) Object.assign(merged, part.$ref === undefined ? part : (defs[String(part.$ref).replace('#/$defs/', '')] ?? {}))
      return walk(merged, stack)
    }
    let type = s['type']
    if (Array.isArray(type)) type = type.find((t: string) => t !== 'null') ?? type[0]
    if (type === undefined && s['properties'] !== undefined) type = 'object'
    switch (type) {
      case 'string': {
        if (typeof s['pattern'] === 'string') return fromPattern(s['pattern'])
        if (s['format'] === 'date-time') return '2026-10-28T00:00:00Z'
        if (s['format'] === 'date') return '2026-10-28'
        if (s['format'] === 'uri') return 'https://example.invalid/x'
        const min = Number(s['minLength'] ?? 0)
        return 'x'.repeat(Math.max(1, min))
      }
      case 'integer':
      case 'number':
        return Math.max(Number(s['minimum'] ?? 0), Number(s['exclusiveMinimum'] ?? Number.NEGATIVE_INFINITY) + 1, 1)
      case 'boolean':
        return false
      case 'null':
        return null
      case 'array': {
        const min = Number(s['minItems'] ?? 0)
        if (min === 0) return []
        const item = walk(s['items'] ?? {}, stack)
        return item === undefined ? undefined : Array.from({ length: min }, () => item)
      }
      case 'object': {
        const out: { [k: string]: Json } = {}
        for (const key of s['required'] ?? []) {
          const v = walk(s['properties']?.[key] ?? {}, stack)
          if (v === undefined) return undefined
          out[key] = v
        }
        return out
      }
      default:
        return null
    }
  }
  return walk(root, [])
}
