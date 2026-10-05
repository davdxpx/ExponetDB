/**
 * Deterministic JSON for generated artifacts: object members sorted by name
 * (UTF-16 order), two-space indentation, LF, trailing newline. No timestamps,
 * paths or tool versions ever enter an artifact.
 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export function stableStringify(value: unknown): string {
  return `${JSON.stringify(sortDeep(value), null, 2)}\n`
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep)
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      Object.defineProperty(out, key, {
        value: sortDeep((value as Record<string, unknown>)[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    return out
  }
  return value
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Moves `$defs` of a generated schema into a shared definitions map and
 * rewrites `#/$defs/X` references to `${prefix}X`. A name that already exists
 * must have an identical definition: one name, one shape.
 */
export function hoistDefinitions(
  schema: Record<string, unknown>,
  into: Map<string, unknown>,
  prefix: string,
): Record<string, unknown> {
  const { $defs, $schema: _schema, ...rest } = schema
  const rewrite = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map(rewrite)
    }
    if (isObject(node)) {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(node)) {
        out[k] =
          k === '$ref' && typeof v === 'string' && v.startsWith('#/$defs/')
            ? `${prefix}${v.slice('#/$defs/'.length)}`
            : rewrite(v)
      }
      return out
    }
    return node
  }
  if (isObject($defs)) {
    for (const [name, definition] of Object.entries($defs)) {
      const rewritten = rewrite(definition)
      const existing = into.get(name)
      if (existing !== undefined && stableStringify(existing) !== stableStringify(rewritten)) {
        throw new Error(`two different schemas use the id ${name}`)
      }
      into.set(name, rewritten)
    }
  }
  const out = rewrite(rest)
  if (!isObject(out)) {
    throw new Error('schema root is not an object')
  }
  return out
}

/** Renames an annotation keyword everywhere in a schema tree (for OpenAPI's `x-` convention). */
export function renameKeyword(node: unknown, from: string, to: string): unknown {
  if (Array.isArray(node)) {
    return node.map((n) => renameKeyword(n, from, to))
  }
  if (isObject(node)) {
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => [k === from ? to : k, renameKeyword(v, from, to)]),
    )
  }
  return node
}
