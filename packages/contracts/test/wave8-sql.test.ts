import { describe, expect, it } from 'vitest'
import {
  ACTIONS,
  contractJsonSchema,
  MCP_TOOL_LIST,
  ROUTE_LIST,
  SQL_CLASSES,
  SQL_CLASSIFY_MAX_BYTES,
  SqlClassificationRequestSchema,
  SqlClassificationSchema,
} from '../src/index.ts'

/** The Wave 8 live statement classification (order §9): the contract of `POST /sql/classifications`. */
describe('sql.classify', () => {
  it('is a REST-only read of migrations.read at the installation, bound to its route', () => {
    const a = ACTIONS['sql.classify']
    expect(a.effect).toBe('read')
    expect(a.subject).toBe('installation')
    expect(a.permission).toEqual({ kind: 'fixed', permission: 'migrations.read' })
    expect(a.clientKinds).not.toContain('mcp')
    expect(MCP_TOOL_LIST.some((t) => t.action === 'sql.classify')).toBe(false)
    const route = ROUTE_LIST.find((r) => r.operationId === 'classifySql')
    expect([route?.method, route?.path, route?.action]).toEqual([
      'post',
      '/sql/classifications',
      'sql.classify',
    ])
    // 64 KiB of SQL escaped as JSON fits the route's body limit.
    expect(route?.maxBodyBytes).toBeGreaterThanOrEqual(SQL_CLASSIFY_MAX_BYTES * 6)
  })

  it('bounds the text in UTF-8 bytes, not characters, and refuses unknown members and grammars', () => {
    const ok = (v: unknown) => SqlClassificationRequestSchema.safeParse(v).success
    expect(ok({ sql: 'SELECT 1' })).toBe(true)
    expect(ok({ sql: 'x'.repeat(SQL_CLASSIFY_MAX_BYTES) })).toBe(true)
    expect(ok({ sql: 'x'.repeat(SQL_CLASSIFY_MAX_BYTES + 1) })).toBe(false)
    // 32769 two-byte characters are within the character bound and above the byte bound.
    expect(ok({ sql: 'é'.repeat(SQL_CLASSIFY_MAX_BYTES / 2) })).toBe(true)
    expect(ok({ sql: 'é'.repeat(SQL_CLASSIFY_MAX_BYTES / 2 + 1) })).toBe(false)
    expect(ok({ sql: '' })).toBe(false)
    expect(ok({ sql: 'SELECT 1', postgresMajor: 15 })).toBe(false)
    expect(ok({ sql: 'SELECT 1', postgresMajor: 18 })).toBe(true)
    expect(ok({ sql: 'SELECT 1', extra: true })).toBe(false)
  })

  it('has the six classes and answers with positions, never with a text member', () => {
    expect([...SQL_CLASSES]).toEqual([
      'read_only',
      'write',
      'destructive',
      'rewrite',
      'non_transactional',
      'security',
    ])
    const shape = JSON.stringify(contractJsonSchema(SqlClassificationSchema, { io: 'output' }))
    expect(shape).toContain('"statements"')
    // No member of the answer is named after the submitted text.
    expect(shape).not.toMatch(/"(sql|text|statement|source_text|snippet|excerpt|query)":/)
  })
})
