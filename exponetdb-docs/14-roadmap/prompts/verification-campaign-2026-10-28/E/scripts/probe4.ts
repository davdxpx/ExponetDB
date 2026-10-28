import { operationNext } from '<TREE>/apps/cli/src/output/views.ts'
const base: any = { id: 'op_01M61ZXSFE83V0SA9C2TBMP6FQ', state: 'needs_attention', applyOutcome: 'applied', verificationOutcome: 'error', nextAction: 'inspect', subject: { targetId: null }, retryable: false }
for (const kind of ['migration.apply', 'backup.run', 'node.enroll', 'ledger.reconcile']) {
  console.log(kind.padEnd(18), 'retryable=' + (kind === 'migration.apply'), '=>', JSON.stringify(operationNext({ ...base, kind, retryable: kind === 'migration.apply' })))
}
