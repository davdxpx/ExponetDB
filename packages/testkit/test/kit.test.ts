import { describe, expect, it } from 'vitest'
import {
  dropDatabase,
  HOSTILE_TABLE_NAMES,
  hostileStatements,
  LARGE_CATALOG,
  largeCatalogStatements,
  reosaShapedStatements,
  TRUNCATED_LONG_NAME,
  uniqueDatabaseName,
} from '../src/index.ts'

describe('test kit', () => {
  it('names test databases so that only they can be dropped', async () => {
    const name = uniqueDatabaseName('Some Label!')
    expect(name).toMatch(/^exdb_t_some_label__[0-9a-f]{10}$/)
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63)
    await expect(
      dropDatabase({ major: 17, host: '127.0.0.1', port: 1 }, 'postgres'),
    ).rejects.toThrow('only test databases are dropped')
  })

  it('builds the fixtures it promises', () => {
    expect(HOSTILE_TABLE_NAMES.length).toBeGreaterThan(10)
    expect(Buffer.byteLength(TRUNCATED_LONG_NAME)).toBe(63)
    expect(hostileStatements().some((s) => s.includes('BEGIN ATOMIC'))).toBe(true)
    expect(reosaShapedStatements().some((s) => s.includes('FORCE ROW LEVEL SECURITY'))).toBe(true)
    expect(reosaShapedStatements().some((s) => /CREATE EVENT TRIGGER/.test(s))).toBe(false)
    expect(LARGE_CATALOG.tables).toBeGreaterThanOrEqual(2000)
    expect(largeCatalogStatements().join('\n')).toContain('hnsw')
  })
})
