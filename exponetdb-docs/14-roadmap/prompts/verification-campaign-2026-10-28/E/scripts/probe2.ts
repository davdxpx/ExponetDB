import { renderHuman } from '<TREE>/apps/cli/src/output/render.ts'
const t: any = { color: false, quiet: false, columns: 100, unicode: false }
const cases: [string, any][] = [
  ['PLAN_STALE', { changedBindings: [{ binding: 'ledgerStateHash', expected: 'sha256:ls1:aa', actual: 'sha256:ls1:bb', hint: 'Migration 01M... was applied at 12:07' }], planId: 'pln_01M61ZXSFE83V0SA9C2TBMP6FQ' }],
  ['OPERATION_CONFLICT', { blockingOperationId: 'op_01M61ZXSFE83V0SA9C2TBMP6FQ' }],
  ['MIGRATION_EXECUTION_FAILED', { applyOutcome: 'not_applied', sqlstate: '42P07', statementIndex: 3, position: 12 }],
  ['MIGRATION_CHECKSUM_MISMATCH', { migrationId: '01M61ZX2TY7FFAKX4GQPJE0E68', knownChecksum: 'sha256:c1:aa', where: { kind: 'target_ledger', targetId: 'tgt_01M61ZXSFE83V0SA9C2TBMP6FQ' } }],
  ['POLICY_DENIED', { rules: [{ id: 'migration.staging-evidence', result: 'fail', severity: 'deny', message: 'x', overridableByBreakGlass: true }] }],
  ['LEDGER_DIVERGENCE', { missing: ['01M61ZX2TY7FFAKX4GQPJE0E68'], checksumDiffers: [], unrecorded: ['01M61ZXSFE83V0SA9C2TBMP6FQ'] }],
  ['APPROVAL_COOLING_PERIOD', { notBefore: '2026-10-28T20:00:00Z' }],
  ['OPERATION_NOT_RETRYABLE', { state: 'needs_attention' }],
  ['VERIFICATION_FAILED', { checks: [{ name: 'index exists', layer: 'L1', status: 'failed' }] }],
]
for (const [code, details] of cases) {
  const r: any = { command: 'plan apply', status: 'failed', blocks: [], error: { code, message: 'MSG', details } }
  const { err } = renderHuman(r, t)
  console.log(code.padEnd(30), '=>', JSON.stringify(err.slice(1)))
}
