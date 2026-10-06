import type { SchemaObjectRef } from '@exponetdb/contracts'
import type { CanonicalEntry, ObjectClass } from '@exponetdb/postgres'
import { clip } from './findings.ts'

/**
 * How canonical entries appear to people and clients: the object kind of
 * the contracts, a reference (schema, name, parent, signature and the
 * canonical key), and a label for summaries. Names come from the catalog
 * and are untrusted data: they are bounded and quoted, never interpreted.
 */
const TYPE_CLASSES: readonly ObjectClass[] = ['enum', 'domain', 'composite_type', 'range_type']

/** The contract kind of an entry (`type` for the four type classes, `procedure` for procedures). */
export function objectKind(entry: Pick<CanonicalEntry, 'class' | 'attributes'>): string {
  if (TYPE_CLASSES.includes(entry.class)) return 'type'
  if (entry.class === 'function' && entry.attributes['kind'] === 'p') return 'procedure'
  return entry.class
}

/** The classes a contract kind covers (for lookups by kind). */
export function classesOfKind(kind: string): readonly ObjectClass[] {
  if (kind === 'type') return TYPE_CLASSES
  if (kind === 'procedure') return ['function']
  return [kind as ObjectClass]
}

/** A SQL-style rendering of a name: bare when simple, double-quoted otherwise. */
export function displayIdent(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`
}

const at = (key: readonly string[], i: number) => key[i] ?? ''

/** Classes keyed by [schema, relation, name]. */
const CHILD_CLASSES: readonly ObjectClass[] = ['column', 'constraint', 'trigger', 'policy', 'rule']
/** Classes keyed by a single global name. */
const GLOBAL_CLASSES: readonly ObjectClass[] = [
  'schema',
  'extension',
  'event_trigger',
  'publication',
]

export function objectRef(
  entry: Pick<CanonicalEntry, 'class' | 'key' | 'attributes'>,
): SchemaObjectRef {
  const key = entry.key
  const base = {
    kind: objectKind(entry),
    key: key.slice(0, 8).map((k) => clip(k, 2048)),
  }
  const name63 = (s: string) => clip(s, 63)
  if (GLOBAL_CLASSES.includes(entry.class)) {
    const schema =
      entry.class === 'schema'
        ? at(key, 0)
        : typeof entry.attributes['schema'] === 'string'
          ? entry.attributes['schema']
          : ''
    return {
      ...base,
      schema: name63(schema),
      name: name63(at(key, 0)),
      signature: null,
      parent: null,
    }
  }
  if (CHILD_CLASSES.includes(entry.class)) {
    return {
      ...base,
      schema: name63(at(key, 0)),
      name: name63(at(key, 2)),
      signature: null,
      parent: name63(at(key, 1)),
    }
  }
  switch (entry.class) {
    case 'function':
      return {
        ...base,
        schema: name63(at(key, 0)),
        name: name63(at(key, 1)),
        signature: clip(at(key, 2), 1024),
        parent: null,
      }
    case 'operator':
      return {
        ...base,
        schema: name63(at(key, 0)),
        name: name63(at(key, 1)),
        signature: clip(`(${at(key, 2)}, ${at(key, 3)})`, 1024),
        parent: null,
      }
    case 'operator_class':
      return {
        ...base,
        schema: name63(at(key, 0)),
        name: name63(at(key, 1)),
        signature: clip(at(key, 2), 1024),
        parent: null,
      }
    case 'default_privileges':
      return {
        ...base,
        schema: name63(at(key, 1)),
        name: name63(at(key, 0)),
        signature: clip(at(key, 2), 1024),
        parent: null,
      }
    case 'cast':
      return {
        ...base,
        schema: '',
        name: name63(`${at(key, 0)} AS ${at(key, 1)}`),
        signature: null,
        parent: null,
      }
    case 'index': {
      const table = entry.attributes['table']
      const parent = Array.isArray(table) && typeof table[1] === 'string' ? table[1] : null
      return {
        ...base,
        schema: name63(at(key, 0)),
        name: name63(at(key, 1)),
        signature: null,
        parent: parent === null ? null : name63(parent),
      }
    }
    default:
      return {
        ...base,
        schema: name63(at(key, 0)),
        name: name63(at(key, 1)),
        signature: null,
        parent: null,
      }
  }
}

/** `table public.accounts`, `column public.accounts.email`, `function public.f(integer)`. */
export function objectLabel(entry: Pick<CanonicalEntry, 'class' | 'key' | 'attributes'>): string {
  const key = entry.key
  const q = (parts: readonly string[]) => parts.map(displayIdent).join('.')
  let name: string
  if (GLOBAL_CLASSES.includes(entry.class)) {
    name = displayIdent(at(key, 0))
  } else if (CHILD_CLASSES.includes(entry.class)) {
    name = q([at(key, 0), at(key, 1), at(key, 2)])
  } else if (entry.class === 'function') {
    name = `${q([at(key, 0), at(key, 1)])}(${at(key, 2)})`
  } else if (entry.class === 'operator') {
    name = `${q([at(key, 0)])}.${at(key, 1)}(${at(key, 2)}, ${at(key, 3)})`
  } else if (entry.class === 'default_privileges') {
    name = `for ${displayIdent(at(key, 0))} in ${at(key, 1) === '' ? '(all schemas)' : displayIdent(at(key, 1))} on ${at(key, 2)}`
  } else if (entry.class === 'cast') {
    name = `(${at(key, 0)} AS ${at(key, 1)})`
  } else {
    name = q([at(key, 0), at(key, 1)])
  }
  return clip(`${entry.class.replace(/_/g, ' ')} ${name}`, 512)
}
