import { verificationRetryable, VERIFICATION_RETRY_KINDS } from '<TREE>/packages/application/src/views.ts'
import { isErrorCode } from '<TREE>/packages/contracts/src/index.ts'
const kinds = ['migration.apply','migration.resume','migration.baseline','migration.verify','migration.rollback','ledger.reconcile','drift.accept','backup.run','restore.drill','node.enroll','postgres.roles.apply','registry.cluster.register','credential.rotate']
for (const kind of kinds) {
  console.log(kind.padEnd(28), 'applied/error ->', verificationRetryable({kind,state:'needs_attention',applyOutcome:'applied',verificationOutcome:'error'}),
    '| unknown/pending ->', verificationRetryable({kind,state:'needs_attention',applyOutcome:'unknown',verificationOutcome:'pending'}))
}
console.log('retry kinds:', [...VERIFICATION_RETRY_KINDS].join(','))
for (const c of ['operation_kind_unknown','operation_state_changed','PLAN_STALE','INTERNAL']) console.log(c, 'isErrorCode:', isErrorCode(c))
