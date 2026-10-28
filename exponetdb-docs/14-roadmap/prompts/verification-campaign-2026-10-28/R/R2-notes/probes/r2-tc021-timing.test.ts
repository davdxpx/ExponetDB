// R2 probe (TC-021): survivingExpectations at the 1,000 / 5,000-file scale of the first campaign
// (7,233 / 36,253 statements, 26,500 / 132,820 expectations). Copy to packages/postgres/test/.
import { describe, expect, it } from 'vitest'
import { survivingExpectations } from '../src/parser/migration.ts'

function facts(statements: number, perStatement: number) {
  return Array.from({ length: statements }, (_, i) => ({
    index: i,
    expectations: Array.from({ length: perStatement }, (_, k) => ({
      kind: 'column' as const, schema: 'public', table: `t${(i * 7 + k) % Math.max(1, Math.floor(statements / 3))}`, column: `c${k}`, present: true,
    })),
    objects: i % 5 === 0 ? [{ kind: 'table' as const, schema: 'public', name: `t${i % Math.max(1, Math.floor(statements / 3))}`, action: 'create' as const }] : [],
  }))
}
describe('R2 TC-021 timing', () => {
  it.each([[100, 703, 4], [1_000, 7_233, 4], [5_000, 36_253, 4], [20_000, 145_078, 4]])('%s files (%s statements)', (files, statements, per) => {
    const f = facts(statements, per) as never
    const t0 = performance.now()
    const out = survivingExpectations(f)
    const ms = Math.round(performance.now() - t0)
    console.log(`R2-TC021 ${files} files, ${statements} statements, ${statements * per} expectations: ${ms} ms, ${out.length} survive`)
    expect(out.length).toBeGreaterThanOrEqual(0)
  })
})
