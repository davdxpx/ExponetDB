import type { Operation } from '@exponetdb/sdk'
import { describe, expect, it } from 'vitest'
import { operationBlocks } from '../src/output/views.ts'

/**
 * `operation show` for a migration the pre-commit gate (L0) rolled back: the
 * human output names the gate's counts and the first failing object, which
 * the operation's error code alone does not.
 */
const MIGRATION = '01M61YZHRC4XMS29N5NTJ2HK8A'

type Progress = NonNullable<Operation['migrations']>[number]

function failedByGate(gate?: Progress['gate']): Operation {
  return {
    id: 'op_01M61X63D5HKCSD5HSRY5JH14P',
    kind: 'migration.apply',
    planId: null,
    state: 'failed',
    applyOutcome: 'not_applied',
    verificationOutcome: 'not_applicable',
    subject: { targetId: null, targetPath: null, clusterId: null, nodeId: null, tier: 'nonprod' },
    actor: { identityId: null, kind: 'system', via: 'system' },
    createdAt: '2026-10-28T10:00:00.000Z',
    updatedAt: '2026-10-28T10:00:01.000Z',
    waitingFor: null,
    approvalUrl: null,
    errorCode: 'VERIFICATION_FAILED',
    steps: [],
    migrations: [
      {
        migrationId: MIGRATION,
        name: 'contacts',
        applyOutcome: 'not_applied',
        verificationOutcome: 'failed',
        statementIndex: null,
        sqlstate: null,
        errorCode: 'VERIFICATION_FAILED',
        ...(gate === undefined ? {} : { gate }),
      },
    ],
  }
}

const linesOf = (o: Operation) =>
  operationBlocks(o).flatMap((b) => (b.kind === 'text' ? b.lines : []))

describe('operation show: the L0 gate of a rolled-back migration', () => {
  it('names the layer, the failed and total assertions and the first failing object', () => {
    const lines = linesOf(
      failedByGate({ layer: 'L0', checks: 13, failed: 4, first: 'constraint "k" on "public"."t"' }),
    )
    expect(lines).toContain(
      `${MIGRATION}: the L0 gate failed 4 of 13 assertions; first: constraint "k" on "public"."t"`,
    )
  })

  it('says nothing about a gate when none was recorded', () => {
    expect(linesOf(failedByGate()).filter((l) => l.includes('L0 gate'))).toEqual([])
  })
})
