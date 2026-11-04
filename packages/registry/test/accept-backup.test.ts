import type { Tx } from '@exponetdb/control-store'
import { systemClock } from '@exponetdb/kernel'
import { KindRegistry, type PlanRecord } from '@exponetdb/operations'
import { RuleRegistry } from '@exponetdb/policy'
import { describe, expect, it } from 'vitest'
import { type RegistryAcceptContext, registryAcceptDependencies } from '../src/apply.ts'

/**
 * P6 of the REOSA production session: a plan's backup requirement (`migration.destructive-backup`)
 * is met only through the composition's backup read, for the plan's own cluster; without that
 * read, for a system actor, or when the read says no, it is not.
 */
const plan = (subject: Record<string, unknown>) => ({ body: { subject } }) as unknown as PlanRecord
const person = {
  identityId: 'idn_01M49F3N8XAQXXKA8BW1X8Q2H8',
  label: 'owner',
  reauthAt: null,
} as never
const requirement = { kind: 'backup', newerThan: 'PT24H', verified: true } as const
const tx = {} as Tx

const context = (backupMet?: RegistryAcceptContext['backupMet']): RegistryAcceptContext => ({
  policy: { registry: new RuleRegistry([]), codeVersion: 'test', clock: systemClock },
  kinds: new KindRegistry([]),
  systemActor: {
    kind: 'system',
    identityId: null,
    label: 'system:serve',
    client: 'system',
    clientId: null,
  } as never,
  ...(backupMet === undefined ? {} : { backupMet }),
})

describe('a backup requirement at plan acceptance (P6)', () => {
  it('asks the backup read for the plan cluster and the age the rule named', async () => {
    const asked: [string | null, string][] = []
    const deps = registryAcceptDependencies(
      tx,
      context(async (_q, clusterId, newerThan) => {
        asked.push([clusterId, newerThan])
        return true
      }),
      person,
    )
    expect(
      await deps.requirementMet?.(
        requirement,
        plan({ clusterId: 'cls_01M5J4RDBP52B715X5HDFKDN5F' }),
      ),
    ).toBe(true)
    expect(asked).toEqual([['cls_01M5J4RDBP52B715X5HDFKDN5F', 'PT24H']])
  })

  it('is not met when the read says no, without a cluster, without a read, or for the system', async () => {
    const no = registryAcceptDependencies(
      tx,
      context(async () => false),
      person,
    )
    expect(await no.requirementMet?.(requirement, plan({ clusterId: 'cls_x' }))).toBe(false)
    const asked: (string | null)[] = []
    const noCluster = registryAcceptDependencies(
      tx,
      context(async (_q, clusterId) => {
        asked.push(clusterId)
        return clusterId !== null
      }),
      person,
    )
    expect(await noCluster.requirementMet?.(requirement, plan({}))).toBe(false)
    expect(asked).toEqual([null])
    const unwired = registryAcceptDependencies(tx, context(), person)
    expect(await unwired.requirementMet?.(requirement, plan({ clusterId: 'cls_x' }))).toBe(false)
    const system = registryAcceptDependencies(
      tx,
      context(async () => true),
      'system',
    )
    expect(await system.requirementMet?.(requirement, plan({ clusterId: 'cls_x' }))).toBe(false)
  })
})
