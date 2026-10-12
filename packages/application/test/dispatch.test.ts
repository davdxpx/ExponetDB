import type { Tx } from '@exponetdb/control-store'
import { newId } from '@exponetdb/kernel'
import type { OperationRecord, PlanRecord } from '@exponetdb/operations'
import type { RegistryAcceptContext } from '@exponetdb/registry'
import { describe, expect, it } from 'vitest'
import { nodeDispatchAdmission } from '../src/index.ts'

/**
 * G6 finding A2: a critical plan runs for a person only, on every tier and
 * whatever its kind. An operation accepted before the authorization engine
 * took the plan's class into account is stopped at dispatch, before the
 * kind's own admission and before anything is sent to a target or a node.
 */
function plan(
  actor: PlanRecord['actor'],
  actionClass: PlanRecord['actionClass'],
  kind = 'postgres.roles.apply',
): PlanRecord {
  return {
    planId: newId('pln', 1),
    kind,
    kindVersion: 1,
    actionClass,
    state: 'consumed',
    decision: 'allow',
    planHash: `sha256:${'0'.repeat(64)}`,
    policyVersion: 'pv1:test',
    actor,
    expiresAt: new Date(0),
    body: {},
  }
}

const operation = {
  operationId: newId('op', 1),
  planId: newId('pln', 1),
  kind: 'postgres.roles.apply',
  kindVersion: 1,
  state: 'queued',
  applyOutcome: 'pending',
  verificationOutcome: 'pending',
  leaseOwner: null,
  attempt: 1,
} as unknown as OperationRecord

// No kind is covered: only the class rule can answer, nothing touches the store.
const admit = nodeDispatchAdmission({} as RegistryAcceptContext, [])
const tx = {} as Tx

const service = {
  kind: 'service',
  identityId: newId('idn', 2),
  client: 'ci',
  clientId: newId('cli', 2),
} as const
const person = {
  kind: 'human',
  identityId: newId('idn', 3),
  client: 'cli',
  clientId: null,
} as const

describe('dispatch admission of a critical plan (G6 finding A2)', () => {
  it('stops a critical plan of a service account, MCP client or system before it starts', async () => {
    expect(await admit(tx, plan(service, 'critical'), operation)).toEqual([
      { binding: 'actor', actual: 'not_human' },
    ])
    expect(
      await admit(
        tx,
        plan({ ...person, client: 'mcp' }, 'critical', 'migration.rollback'),
        operation,
      ),
    ).toEqual([{ binding: 'actor', actual: 'not_human' }])
    expect(
      await admit(
        tx,
        plan({ kind: 'system', identityId: null, client: 'system', clientId: null }, 'critical'),
        operation,
      ),
    ).toEqual([{ binding: 'actor', actual: 'not_human' }])
  })

  it('lets a person through the Web App or the first-party CLI through', async () => {
    expect(await admit(tx, plan(person, 'critical'), operation)).toEqual([])
    expect(await admit(tx, plan({ ...person, client: 'web' }, 'critical'), operation)).toEqual([])
  })

  it('leaves a non-critical plan of a service account to the kind', async () => {
    expect(await admit(tx, plan(service, 'high'), operation)).toEqual([])
  })
})
