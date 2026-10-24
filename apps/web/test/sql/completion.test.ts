import type { SchemaObject, SchemaObjectRef } from '@exponetdb/sdk/operations'
import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import {
  columnItems,
  createCompletionProvider,
  pickRelation,
} from '../../src/features/sql/completion.ts'
import type { ApiClient } from '../../src/lib/api/client.ts'

const PATH = 'shop/platform/staging'

function ref(name: string, schema = 'public', kind = 'table'): SchemaObjectRef {
  return { kind, schema, name, signature: null, parent: null, key: [schema, name] }
}

function object(columns: SchemaObject['columns'], over: Partial<SchemaObject> = {}): SchemaObject {
  return {
    columns,
    comment: null,
    constraints: null,
    definition: null,
    grants: null,
    indexes: null,
    observedAt: '2026-10-20T10:00:00Z',
    owner: 'app',
    policies: null,
    ref: ref('users'),
    rowLevelSecurity: null,
    sizeBytes: null,
    source: 'live',
    ...over,
  }
}

function column(name: string, type = 'text') {
  return { name, type, nullable: true, default: null, generated: null, identity: null }
}

interface Calls {
  readonly search: { q: string; kinds: readonly string[]; limit: number }[]
  readonly object: { kind: string; qualifiedName: string }[]
}

/** A client whose catalog is a few fixed answers; every call is recorded. */
function setup(
  refs: readonly SchemaObjectRef[],
  objects: Record<string, SchemaObject | Error> = {},
) {
  const calls: Calls = { search: [], object: [] }
  const operation = vi.fn(async (id: string, args: Record<string, unknown>) => {
    if (id === 'searchSchema') {
      const query = args['query'] as { q: string; kinds: readonly string[]; limit: number }
      calls.search.push({ q: query.q, kinds: query.kinds, limit: query.limit })
      return { items: refs.filter((r) => r.name.includes(query.q)), nextCursor: null }
    }
    const params = args['params'] as { kind: string; qualifiedName: string }
    calls.object.push({ kind: params.kind, qualifiedName: params.qualifiedName })
    const found = objects[params.qualifiedName]
    if (found === undefined) throw new Error('not found')
    if (found instanceof Error) throw found
    return found
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const provider = createCompletionProvider(
    { operation } as unknown as ApiClient,
    queryClient,
    PATH,
  )
  return { provider, calls, queryClient }
}

const USERS = '"public"."users"'

describe('column completion', () => {
  it('offers the columns of the relation an alias stands for, with their types as details', async () => {
    const { provider, calls } = setup([ref('users')], {
      [USERS]: object([
        column('id', 'bigint'),
        column('email'),
        column('Created At', 'timestamptz'),
      ]),
    })
    const items = await provider({
      word: 'u.',
      before: 'SELECT ',
      after: ' FROM public.users u WHERE true',
    })
    expect(items).toEqual([
      { label: 'id', kind: 'column', detail: 'bigint' },
      { label: 'email', kind: 'column', detail: 'text' },
      { label: '"Created At"', kind: 'column', detail: 'timestamptz' },
    ])
    // The relation behind an alias is an exact-name lookup, so it asks for the larger page.
    expect(calls.search).toEqual([
      { q: 'users', kinds: ['table', 'view', 'materialized_view'], limit: 200 },
    ])
    expect(calls.object).toEqual([{ kind: 'table', qualifiedName: USERS }])
  })

  it('reads the FROM clause that comes after the cursor and the one before it', async () => {
    const { provider } = setup([ref('users')], { [USERS]: object([column('id')]) })
    const before = await provider({
      word: 'u.i',
      before: 'SELECT 1 FROM users u WHERE ',
      after: '',
    })
    expect(before.map((i) => i.label)).toEqual(['id'])
    const after = await provider({ word: 'u.i', before: 'SELECT ', after: ' FROM users u' })
    expect(after.map((i) => i.label)).toEqual(['id'])
  })

  it('reads a relation with no alias by its own name, and schema.relation.', async () => {
    const { provider, calls } = setup([ref('users')], { [USERS]: object([column('id')]) })
    expect((await provider({ word: 'users.', before: '', after: ' FROM users' })).length).toBe(1)
    expect(
      (await provider({ word: 'public.users.', before: 'SELECT ', after: '' })).map((i) => i.label),
    ).toEqual(['id'])
    expect(calls.object).toHaveLength(1)
  })

  it('asks for a relation once for a burst of keystrokes, in sequence and at the same time', async () => {
    const { provider, calls } = setup([ref('users')], { [USERS]: object([column('id')]) })
    const ask = (word: string) => provider({ word, before: 'SELECT ', after: ' FROM users u' })
    await ask('u.')
    await ask('u.i')
    await ask('u.id')
    expect(calls.search).toHaveLength(1)
    expect(calls.object).toHaveLength(1)

    const fresh = setup([ref('users')], { [USERS]: object([column('id')]) })
    const askFresh = (word: string) =>
      fresh.provider({ word, before: 'SELECT ', after: ' FROM users u' })
    await Promise.all([askFresh('u.'), askFresh('u.e'), askFresh('u.em')])
    expect(fresh.calls.search).toHaveLength(1)
    expect(fresh.calls.object).toHaveLength(1)
  })

  it('reads only the one relation, never the catalog', async () => {
    const { provider, calls } = setup([ref('users'), ref('orders'), ref('items')], {
      [USERS]: object([column('id')]),
    })
    await provider({ word: 'u.', before: 'SELECT ', after: ' FROM users u JOIN orders o ON true' })
    expect(calls.search.map((s) => s.q)).toEqual(['users'])
    expect(calls.object).toHaveLength(1)
  })

  it('uses the kind of the relation: a view and a materialized view', async () => {
    const { provider, calls } = setup(
      [ref('active_users', 'public', 'view'), ref('totals', 'public', 'materialized_view')],
      {
        '"public"."active_users"': object([column('id')]),
        '"public"."totals"': object([column('n', 'bigint')]),
      },
    )
    await provider({ word: 'v.', before: '', after: ' FROM active_users v' })
    await provider({ word: 't.', before: '', after: ' FROM totals t' })
    expect(calls.object.map((o) => o.kind)).toEqual(['view', 'materialized_view'])
  })

  it('does not complete an alias of a name the target does not have', async () => {
    const { provider, calls } = setup([], {})
    expect(await provider({ word: 'g.', before: '', after: ' FROM ghosts g' })).toEqual([])
    expect(calls.object).toEqual([])
  })

  it('takes the relation in public when several schemas hold the name, and none without public', async () => {
    const refs = [
      ref('events', 'audit'),
      ref('events', 'public'),
      ref('logs', 'a'),
      ref('logs', 'b'),
    ]
    expect(pickRelation(refs, { schema: undefined, name: 'events' })?.schema).toBe('public')
    expect(pickRelation(refs, { schema: undefined, name: 'logs' })).toBeUndefined()
    expect(pickRelation(refs, { schema: 'audit', name: 'events' })?.schema).toBe('audit')
    expect(pickRelation(refs, { schema: 'nope', name: 'events' })).toBeUndefined()
    expect(
      pickRelation([ref('events', 'public', 'function')], { schema: undefined, name: 'events' }),
    ).toBeUndefined()
  })

  it('offers nothing for a relation without columns, and does not turn to schema names', async () => {
    const { provider, calls } = setup([ref('users')], { [USERS]: object(null) })
    expect(await provider({ word: 'u.', before: '', after: ' FROM users u' })).toEqual([])
    expect(calls.search).toHaveLength(1)
  })

  it('fails the completion, offering nothing, when the relation cannot be read', async () => {
    const { provider } = setup([ref('users')], { [USERS]: new Error('unavailable') })
    await expect(provider({ word: 'u.', before: '', after: ' FROM users u' })).rejects.toThrow()
  })

  it('quotes column names that are not plain and keeps hostile text as text', async () => {
    const hostile = [
      column('a"b'),
      column('<script>alert(1)</script>'),
      column('MixedCase'),
      column('with space'),
      column('line\nbreak'),
      column('x', 'text‮'),
    ]
    const { provider } = setup([ref('users')], { [USERS]: object(hostile) })
    const items = await provider({ word: 'u.', before: '', after: ' FROM users u' })
    expect(items.map((i) => i.label)).toEqual([
      '"a""b"',
      '"<script>alert(1)</script>"',
      '"MixedCase"',
      '"with space"',
      '"line\nbreak"',
      'x',
    ])
    expect(items.every((i) => i.kind === 'column')).toBe(true)
  })

  it('maps a missing column list to no items', () => {
    expect(columnItems(null)).toEqual([])
    expect(columnItems([])).toEqual([])
  })
})

describe('completion that is not a column', () => {
  it('still offers the relations of a schema for schema. when the qualifier is no alias', async () => {
    const { provider, calls } = setup([ref('users'), ref('orders', 'other')], {})
    const items = await provider({ word: 'public.us', before: 'SELECT * FROM ', after: '' })
    expect(items.map((i) => i.label)).toEqual(['users'])
    expect(calls.search).toEqual([
      { q: 'us', kinds: ['table', 'view', 'materialized_view', 'function'], limit: 50 },
    ])
    expect(calls.object).toEqual([])
  })

  it('asks for nothing after a trailing dot that is no relation', async () => {
    const { provider, calls } = setup([ref('users')], {})
    expect(await provider({ word: 'public.', before: 'SELECT * FROM ', after: '' })).toEqual([])
    expect(calls.search).toEqual([])
  })

  it('searches names for a word with no dot, as before', async () => {
    const { provider, calls } = setup([ref('users')], {})
    const items = await provider({ word: 'us', before: 'SELECT * FROM ', after: '' })
    expect(items.map((i) => i.label)).toEqual(['users'])
    expect(calls.search[0]?.kinds).toEqual([
      'schema',
      'table',
      'view',
      'materialized_view',
      'function',
    ])
  })

  it('works with a provider context that has no text after the word', async () => {
    const { provider } = setup([ref('users')], { [USERS]: object([column('id')]) })
    const items = await provider({ word: 'users.', before: 'SELECT * FROM users WHERE ' })
    expect(items.map((i) => i.label)).toEqual(['id'])
  })
})
