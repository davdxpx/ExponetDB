import { describe, expect, it } from 'vitest'

import {
  columnKind,
  describeColumns,
  isNumericKind,
  sameColumns,
} from '../../src/grid/column-kind.ts'

describe('columnKind', () => {
  it.each([
    ['int2', 'integer'],
    ['int4', 'integer'],
    ['int8', 'integer'],
    ['bigint', 'integer'],
    ['integer', 'integer'],
    ['oid', 'integer'],
    ['float4', 'float'],
    ['float8', 'float'],
    ['double precision', 'float'],
    ['real', 'float'],
    ['numeric', 'numeric'],
    ['numeric(10,2)', 'numeric'],
    ['money', 'numeric'],
    ['bool', 'boolean'],
    ['boolean', 'boolean'],
    ['json', 'json'],
    ['jsonb', 'json'],
    ['bytea', 'bytea'],
    ['timestamptz', 'temporal'],
    ['timestamp with time zone', 'temporal'],
    ['timestamp(3) with time zone', 'temporal'],
    ['date', 'temporal'],
    ['interval', 'temporal'],
    ['uuid', 'uuid'],
    ['_text', 'array'],
    ['_int4', 'array'],
    ['text[]', 'array'],
    ['integer[][]', 'array'],
    ['text', 'text'],
    ['varchar', 'text'],
    ['character varying(255)', 'text'],
    ['citext', 'text'],
    ['public.order_status', 'text'],
    ['vector', 'text'],
    ['', 'text'],
  ] as const)('reads %j as %s', (type, kind) => {
    expect(columnKind(type)).toBe(kind)
  })

  it('accepts a schema-qualified catalog name and any letter case', () => {
    expect(columnKind('pg_catalog.int4')).toBe('integer')
    expect(columnKind('  BIGINT ')).toBe('integer')
    expect(columnKind('JSONB')).toBe('json')
  })

  it('knows which kinds are numbers', () => {
    expect(isNumericKind('integer')).toBe(true)
    expect(isNumericKind('float')).toBe(true)
    expect(isNumericKind('numeric')).toBe(true)
    expect(isNumericKind('text')).toBe(false)
    expect(isNumericKind('temporal')).toBe(false)
  })

  it('describes columns once, with the masked flag defaulted', () => {
    expect(
      describeColumns([
        { name: 'id', type: 'int8' },
        { name: 'secret', type: 'text', masked: true },
      ]),
    ).toEqual([
      { name: 'id', type: 'int8', masked: false, kind: 'integer' },
      { name: 'secret', type: 'text', masked: true, kind: 'text' },
    ])
  })
})

describe('sameColumns', () => {
  it('compares name, type and masked, not identity', () => {
    const a = [
      { name: 'id', type: 'int8' },
      { name: 'x', type: 'text', masked: false },
    ]
    const b = [
      { name: 'id', type: 'int8', masked: false },
      { name: 'x', type: 'text' },
    ]
    expect(sameColumns(a, b)).toBe(true)
    expect(sameColumns(a, a)).toBe(true)
    expect(sameColumns(a, [...b].reverse())).toBe(false)
    expect(sameColumns(a, b.slice(0, 1))).toBe(false)
    expect(
      sameColumns(a, [
        { name: 'id', type: 'int8' },
        { name: 'x', type: 'text', masked: true },
      ]),
    ).toBe(false)
    expect(
      sameColumns(a, [
        { name: 'id', type: 'int4' },
        { name: 'x', type: 'text' },
      ]),
    ).toBe(false)
  })
})
