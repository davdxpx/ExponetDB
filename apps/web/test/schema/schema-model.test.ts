import type { SchemaObject, SchemaObjectRef } from '@exponetdb/sdk/operations'
import { describe, expect, it } from 'vitest'
import {
  buildErdData,
  columnKeys,
  erdTableId,
  formatBytes,
  invalidIndexes,
  isBrowsableKind,
  kindPlan,
  neighborhood,
  parseForeignKey,
  parsePrimaryKey,
  parseUniqueColumns,
  primaryKeyOf,
  qualifiedName,
  refKey,
  rlsWithoutPolicy,
  securityDefinerWithoutSearchPath,
} from '../../src/features/schema/schema-model.ts'
import { SCHEMA_KINDS } from '../../src/lib/navigation/links.ts'
import { objectFixture, ref } from '../target-overview/support.tsx'

describe('qualifiedName: every part of the canonical key is quoted', () => {
  it('quotes a plain table', () => {
    expect(qualifiedName(ref({ name: 'orders' }))).toBe('"public"."orders"')
  })

  it.each([
    ['a quote', 'or"ders', '"public"."or""ders"'],
    ['dollar quotes', 'a$$b', '"public"."a$$b"'],
    ['a dot', 'a.b', '"public"."a.b"'],
    ['a space', 'my table', '"public"."my table"'],
    ['a bidi override', 'a‮b', '"public"."a‮b"'],
    ['a parenthesis', 'f(x)', '"public"."f(x)"'],
  ])('keeps %s inside one quoted part', (_label, name, expected) => {
    expect(qualifiedName(ref({ name }))).toBe(expected)
  })

  it('keeps a name of 63 bytes whole', () => {
    const name = 'n'.repeat(63)
    expect(qualifiedName(ref({ name }))).toBe(`"public"."${name}"`)
  })

  it('names a policy or trigger with its table, an index by schema and name', () => {
    expect(
      qualifiedName(
        ref({ kind: 'policy', name: 'p', parent: 'orders', key: ['public', 'orders', 'p'] }),
      ),
    ).toBe('"public"."orders"."p"')
    expect(qualifiedName(ref({ kind: 'index', name: 'i', key: ['public', 'i'] }))).toBe(
      '"public"."i"',
    )
  })

  it('names a function with its identity arguments after the quoted name', () => {
    const f: SchemaObjectRef = {
      kind: 'function',
      schema: 'public',
      name: 'f',
      signature: 'integer, text',
      parent: null,
      key: ['public', 'f', 'integer, text'],
    }
    expect(qualifiedName(f)).toBe('"public"."f"(integer, text)')
  })

  it('names an extension or schema by its one key part, and nothing without a key', () => {
    expect(qualifiedName(ref({ kind: 'extension', name: 'pgcrypto', key: ['pgcrypto'] }))).toBe(
      '"pgcrypto"',
    )
    expect(qualifiedName(ref({ name: 'x', key: [] }))).toBeUndefined()
  })

  it('tells two overloads apart in the key of a list row', () => {
    const a = ref({ kind: 'function', name: 'f', key: ['public', 'f', 'integer'] })
    const b = ref({ kind: 'function', name: 'f', key: ['public', 'f', 'text'] })
    expect(refKey(a)).not.toBe(refKey(b))
  })
})

describe('kindPlan: every route kind has a plan', () => {
  it.each(SCHEMA_KINDS)('plans %s', (kind) => {
    const plan = kindPlan(kind)
    expect(['objects', 'visualizer', 'unsupported']).toContain(plan.type)
    if (plan.type === 'objects') expect(plan.kinds.length).toBeGreaterThan(0)
  })

  it('lists functions and procedures together, and roles as unsupported', () => {
    expect(kindPlan('functions')).toMatchObject({ kinds: ['function', 'procedure'] })
    expect(kindPlan('roles').type).toBe('unsupported')
    expect(kindPlan('visualizer').type).toBe('visualizer')
  })
})

describe('securityDefinerWithoutSearchPath', () => {
  const header = (lines: string[], body = 'BEGIN RETURN 1; END') =>
    `CREATE OR REPLACE FUNCTION public.f()\n RETURNS integer\n LANGUAGE plpgsql\n${lines.join('\n')}\nAS $function$ ${body} $function$\n`

  it('flags SECURITY DEFINER without a search_path in the header', () => {
    expect(securityDefinerWithoutSearchPath(header([' SECURITY DEFINER']))).toBe(true)
  })

  it('does not flag SECURITY DEFINER with a search_path', () => {
    expect(
      securityDefinerWithoutSearchPath(
        header([' SECURITY DEFINER', " SET search_path TO 'public'"]),
      ),
    ).toBe(false)
  })

  it('does not flag SECURITY INVOKER', () => {
    expect(securityDefinerWithoutSearchPath(header([]))).toBe(false)
  })

  it('cannot be switched by text in the body', () => {
    const body = '\n SECURITY DEFINER\n'
    expect(securityDefinerWithoutSearchPath(header([], body))).toBe(false)
    // A search_path in the body does not hide a definer in the header either.
    expect(
      securityDefinerWithoutSearchPath(header([' SECURITY DEFINER'], '\n SET search_path TO x\n')),
    ).toBe(true)
  })

  it('has no opinion about a missing definition', () => {
    expect(securityDefinerWithoutSearchPath(null)).toBe(false)
  })
})

describe('hints from the object read', () => {
  const table = objectFixture(ref({ name: 't' }))

  it('flags RLS on with no policy, and nothing else', () => {
    expect(
      rlsWithoutPolicy({
        ...table,
        rowLevelSecurity: { enabled: true, forced: false },
        policies: [],
      }),
    ).toBe(true)
    expect(
      rlsWithoutPolicy({
        ...table,
        rowLevelSecurity: { enabled: false, forced: false },
        policies: [],
      }),
    ).toBe(false)
    // Policies were not read: no claim.
    expect(
      rlsWithoutPolicy({
        ...table,
        rowLevelSecurity: { enabled: true, forced: false },
        policies: null,
      }),
    ).toBe(false)
  })

  it('lists invalid indexes', () => {
    expect(
      invalidIndexes({
        ...table,
        indexes: [
          { name: 'a', definition: '', unique: false, valid: true },
          { name: 'b', definition: '', unique: false, valid: false },
        ],
      }),
    ).toEqual(['b'])
  })

  it('formats sizes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1536)).toBe('1.5 KiB')
    expect(formatBytes(-1)).toBe('')
  })
})

describe('foreign keys for the diagram', () => {
  it('reads columns and the referenced table', () => {
    expect(
      parseForeignKey(
        'FOREIGN KEY (user_id, org_id) REFERENCES public.users(id, org_id) ON DELETE CASCADE',
      ),
    ).toEqual({
      fromColumns: ['user_id', 'org_id'],
      toSchema: 'public',
      toTable: 'users',
      toColumns: ['id', 'org_id'],
    })
  })

  it('reads quoted identifiers with doubled quotes, dots and dollar signs', () => {
    expect(parseForeignKey('FOREIGN KEY ("a""b") REFERENCES "my.schema"."t$$x"("c d")')).toEqual({
      fromColumns: ['a"b'],
      toSchema: 'my.schema',
      toTable: 't$$x',
      toColumns: ['c d'],
    })
  })

  it('reads an unqualified referenced table', () => {
    expect(parseForeignKey('FOREIGN KEY (a) REFERENCES users(id)')).toMatchObject({
      toSchema: null,
      toTable: 'users',
    })
  })

  it.each([
    'CHECK (a > 0)',
    'FOREIGN KEY a REFERENCES t(id)',
    'FOREIGN KEY (a) REFERENCES',
    'FOREIGN KEY ("a) REFERENCES t(id)',
    'FOREIGN KEY (a) REFERENCES t(id',
    '',
  ])('gives up on text of another shape: %s', (text) => {
    expect(parseForeignKey(text)).toBeUndefined()
  })

  it('reads a primary key', () => {
    expect(parsePrimaryKey('PRIMARY KEY (id, "x y")')).toEqual(['id', 'x y'])
    expect(parsePrimaryKey('UNIQUE (id)')).toEqual([])
  })

  function table(name: string, constraints: SchemaObject['constraints']): SchemaObject {
    return objectFixture(ref({ name }), {
      columns: [
        {
          name: 'id',
          type: 'uuid',
          nullable: false,
          default: null,
          generated: null,
          identity: null,
        },
        {
          name: 'user_id',
          type: 'uuid',
          nullable: true,
          default: null,
          generated: null,
          identity: null,
        },
      ],
      constraints,
    })
  }

  it('draws a relation only when both tables were read and counts the others', () => {
    const users = table('users', [
      { name: 'users_pk', type: 'primary_key', definition: 'PRIMARY KEY (id)', validated: true },
    ])
    const orders = table('orders', [
      {
        name: 'orders_user_fk',
        type: 'foreign_key',
        definition: 'FOREIGN KEY (user_id) REFERENCES public.users(id)',
        validated: true,
      },
      {
        name: 'orders_other_fk',
        type: 'foreign_key',
        definition: 'FOREIGN KEY (user_id) REFERENCES public.elsewhere(id)',
        validated: true,
      },
      { name: 'orders_bad_fk', type: 'foreign_key', definition: 'garbled', validated: true },
    ])
    const { data, undrawn } = buildErdData([users, orders])
    expect(data.tables.map((t) => t.name)).toEqual(['users', 'orders'])
    expect(data.tables[0]?.columns.find((c) => c.name === 'id')?.pk).toBe(true)
    expect(data.relations).toEqual([
      {
        name: 'orders_user_fk',
        fromTable: erdTableId('public', 'orders'),
        fromColumns: ['user_id'],
        toTable: erdTableId('public', 'users'),
        toColumns: ['id'],
      },
    ])
    expect(undrawn).toBe(2)
  })
})

describe('key tokens and the primary key', () => {
  const column = (name: string) => ({
    name,
    type: 'uuid',
    nullable: false,
    default: null,
    generated: null,
    identity: null,
  })

  function orders(constraints: SchemaObject['constraints'], names = ['id', 'user_id', 'sku']) {
    return objectFixture(ref({ name: 'orders' }), { columns: names.map(column), constraints })
  }

  it('reads UNIQUE definitions, with or without NULLS NOT DISTINCT', () => {
    expect(parseUniqueColumns('UNIQUE (sku)')).toEqual(['sku'])
    expect(parseUniqueColumns('UNIQUE (a, "b c")')).toEqual(['a', 'b c'])
    expect(parseUniqueColumns('UNIQUE NULLS NOT DISTINCT (sku)')).toEqual(['sku'])
    expect(parseUniqueColumns('CHECK (x > 0)')).toEqual([])
    expect(parseUniqueColumns('UNIQUE (a')).toEqual([])
  })

  it('marks PK, UQ and FK on the columns they name, from the constraints only', () => {
    const keys = columnKeys(
      orders([
        { name: 'o_pk', type: 'primary_key', definition: 'PRIMARY KEY (id)', validated: true },
        { name: 'o_sku', type: 'unique', definition: 'UNIQUE (sku)', validated: true },
        {
          name: 'o_two',
          type: 'unique',
          definition: 'UNIQUE (user_id, sku)',
          validated: true,
        },
        {
          name: 'o_user',
          type: 'foreign_key',
          definition: 'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE',
          validated: true,
        },
      ]),
    )
    expect(keys.get('id')).toEqual({ primary: true, unique: [], references: [] })
    expect(keys.get('sku')?.unique).toEqual([
      { name: 'o_sku', composite: false },
      { name: 'o_two', composite: true },
    ])
    expect(keys.get('user_id')).toEqual({
      primary: false,
      unique: [{ name: 'o_two', composite: true }],
      references: [{ constraint: 'o_user', schema: 'auth', table: 'users', column: 'id' }],
    })
  })

  it('reads a reference without a schema as the schema of the table itself', () => {
    const keys = columnKeys(
      orders([
        {
          name: 'o_user',
          type: 'foreign_key',
          definition: 'FOREIGN KEY (user_id) REFERENCES users(id)',
          validated: true,
        },
      ]),
    )
    expect(keys.get('user_id')?.references).toEqual([
      { constraint: 'o_user', schema: 'public', table: 'users', column: 'id' },
    ])
  })

  it('pairs each column of a composite foreign key with its own referenced column', () => {
    const keys = columnKeys(
      orders([
        {
          name: 'o_fk',
          type: 'foreign_key',
          definition: 'FOREIGN KEY (id, sku) REFERENCES public.items(a, b)',
          validated: true,
        },
      ]),
    )
    expect(keys.get('id')?.references[0]?.column).toBe('a')
    expect(keys.get('sku')?.references[0]?.column).toBe('b')
  })

  it('gives no token for a definition that does not parse', () => {
    const keys = columnKeys(
      orders([
        { name: 'a', type: 'foreign_key', definition: 'garbled', validated: true },
        { name: 'b', type: 'primary_key', definition: 'PRIMARY KEY (id', validated: true },
        { name: 'c', type: 'check', definition: 'CHECK (id IS NOT NULL)', validated: true },
      ]),
    )
    expect(keys.size).toBe(0)
  })

  it('keeps a hostile column name as one name', () => {
    const name = 'a"; DROP TABLE x; --'
    const keys = columnKeys(
      orders(
        [
          {
            name: 'o_pk',
            type: 'primary_key',
            definition: `PRIMARY KEY ("a""; DROP TABLE x; --")`,
            validated: true,
          },
        ],
        [name],
      ),
    )
    expect(keys.get(name)?.primary).toBe(true)
  })

  it('takes the primary key in key order, only when every column is a column of the object', () => {
    expect(
      primaryKeyOf(
        orders([
          {
            name: 'o_pk',
            type: 'primary_key',
            definition: 'PRIMARY KEY (user_id, id)',
            validated: true,
          },
        ]),
      ),
    ).toEqual(['user_id', 'id'])
    expect(
      primaryKeyOf(
        orders([
          { name: 'o_pk', type: 'primary_key', definition: 'PRIMARY KEY (ghost)', validated: true },
        ]),
      ),
    ).toEqual([])
    expect(primaryKeyOf(orders(null))).toEqual([])
    expect(primaryKeyOf(orders([]))).toEqual([])
  })

  it('browses tables, views and materialized views only', () => {
    expect(['table', 'view', 'materialized_view'].every(isBrowsableKind)).toBe(true)
    expect(['function', 'index', 'schema', 'sequence', 'trigger'].some(isBrowsableKind)).toBe(false)
  })
})

describe('neighborhood: one table with the tables next to it', () => {
  const data = {
    tables: ['a', 'b', 'c', 'd'].map((name) => ({
      id: name,
      schema: 'public',
      name,
      columns: [],
    })),
    relations: [
      { name: 'ab', fromTable: 'a', fromColumns: ['x'], toTable: 'b', toColumns: ['id'] },
      { name: 'cb', fromTable: 'c', fromColumns: ['x'], toTable: 'b', toColumns: ['id'] },
      { name: 'cd', fromTable: 'c', fromColumns: ['y'], toTable: 'd', toColumns: ['id'] },
    ],
  }

  it('keeps the table, the tables it references and the tables that reference it', () => {
    const near = neighborhood(data, 'b')
    expect(near.tables.map((t) => t.id)).toEqual(['a', 'b', 'c'])
    expect(near.relations.map((r) => r.name)).toEqual(['ab', 'cb'])
  })

  it('keeps the relations among the neighbors too', () => {
    const near = neighborhood(data, 'c')
    expect(near.tables.map((t) => t.id)).toEqual(['b', 'c', 'd'])
    expect(near.relations.map((r) => r.name)).toEqual(['cb', 'cd'])
  })

  it('is just the table when nothing points at it', () => {
    const lone = neighborhood({ ...data, relations: [] }, 'a')
    expect(lone.tables.map((t) => t.id)).toEqual(['a'])
  })

  it('leaves the data as it is for a table that is not in it', () => {
    expect(neighborhood(data, 'ghost')).toBe(data)
  })
})
