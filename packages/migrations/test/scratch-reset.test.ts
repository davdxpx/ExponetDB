import { describe, expect, it } from 'vitest'
import { scratchResetSql } from '../src/format/index.ts'

/** The in-place reset script (legacy-import.md §2.5): only for the named scratch target. */
const BASE = {
  installationId: 'ins_01M5G6EQ7KP3PMPC7G3HJ7KH7R',
  targetId: 'tgt_01M5G6EQ7KP3PMPC7G3HJ7KH7R',
  targetPath: "acme/platform/scratch'; DROP DATABASE x; --",
  generation: 2,
}

describe('scratchResetSql', () => {
  it('stops unless the marker names this target and the ledger is empty', () => {
    const sql = scratchResetSql({ ...BASE, includeSchemas: ['public', 'app'] })
    expect(sql).toContain("installation_id = 'ins_01M5G6EQ7KP3PMPC7G3HJ7KH7R'")
    expect(sql).toContain("target_id = 'tgt_01M5G6EQ7KP3PMPC7G3HJ7KH7R'")
    expect(sql).toContain('generation = 2')
    expect(sql).toContain('IF EXISTS (SELECT FROM exponetdb.schema_migrations)')
    expect(sql).toContain("managed text[] := ARRAY['public', 'app']::text[];")
    expect(sql.startsWith('-- ExponetDB')).toBe(true)
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true)
  })

  it('never lets the target path or a schema name out of a literal', () => {
    const sql = scratchResetSql({ ...BASE, includeSchemas: ["o'brien"] })
    expect(sql).toContain("ARRAY['o''brien']::text[]")
    // The path appears in comments and in one literal, quotes doubled.
    expect(sql).toContain("'acme/platform/scratch''; DROP DATABASE x; --'")
    expect(
      sql
        .split('\n')
        .filter(
          (l) =>
            l.includes('DROP DATABASE') && !l.trimStart().startsWith('--') && !l.includes("''"),
        ),
    ).toEqual([])
  })

  it('quotes the block with a tag that no schema name contains', () => {
    expect(scratchResetSql({ ...BASE, includeSchemas: ['public'] })).toContain('DO $reset$\n')
    const sql = scratchResetSql({
      ...BASE,
      includeSchemas: ['a$reset$;COMMIT;CREATE TABLE public.x(i int);--', 'b$reset1$'],
    })
    expect(sql).toContain('DO $reset2$\n')
    expect(sql.trimEnd().endsWith('$reset2$;\nCOMMIT;')).toBe(true)
    expect(sql.split('$reset2$')).toHaveLength(3)
  })

  it('resolves every name in the system catalog only', () => {
    const sql = scratchResetSql({ ...BASE, includeSchemas: ['public'] })
    expect(sql).toContain('BEGIN;\n-- ')
    expect(sql.indexOf('SET LOCAL search_path = pg_catalog, pg_temp;')).toBeLessThan(
      sql.indexOf('DO $reset$'),
    )
  })

  it('refuses to drop what outside the scope depends on the scope', () => {
    const sql = scratchResetSql({ ...BASE, includeSchemas: ['public'] })
    expect(sql).toContain("RAISE EXCEPTION 'objects outside the managed scope depend on it")
    expect(sql.indexOf('INTO outside')).toBeLessThan(sql.indexOf("format('DROP SCHEMA"))
  })

  it('takes every schema but the excluded ones when the scope lists none', () => {
    const sql = scratchResetSql({ ...BASE, excludeSchemas: ['auth'] })
    expect(sql).toContain("NOT (n.nspname = ANY (ARRAY['auth']::text[]))")
    expect(sql).toContain("n.nspname NOT IN ('information_schema', 'exponetdb')")
  })

  it('refuses ids and generations that are not canonical', () => {
    expect(() => scratchResetSql({ ...BASE, targetId: "tgt_x'; --" })).toThrow()
    expect(() => scratchResetSql({ ...BASE, installationId: 'nope' })).toThrow()
    expect(() => scratchResetSql({ ...BASE, generation: 0 })).toThrow()
  })
})
