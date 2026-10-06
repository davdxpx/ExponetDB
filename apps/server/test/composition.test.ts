import type { ControlStore } from '@exponetdb/control-store'
import { systemClock } from '@exponetdb/kernel'
import { generateKeyringText, parseKeyring } from '@exponetdb/secrets'
import { describe, expect, it } from 'vitest'
import {
  CLUSTER_CONNECTIONS,
  connectorFor,
  processBudget,
  type RegistryRuntime,
} from '../src/composition/registry.ts'

/**
 * The installation's connection budget per cluster (postgres-adapter.md §3,
 * G4 record §5 D4): every connector of a process draws from one budget, so
 * operation sessions, observation reads and health probes together never
 * exceed the process's share, and the shares add up to 8.
 */
function runtime(): RegistryRuntime {
  const keyring = parseKeyring(generateKeyringText('test-key'))
  if (!keyring.ok) throw new Error('keyring')
  return {
    store: {} as ControlStore,
    keyring: keyring.value,
    clock: systemClock,
    installationId: 'ins_01M4A000000000000000000001',
  }
}

describe('connection budget per process', () => {
  it('splits the installation limit of 8 per cluster between serve and the worker', () => {
    expect(CLUSTER_CONNECTIONS.serve + CLUSTER_CONNECTIONS.worker).toBe(8)
  })

  it('gives every connector of one process the same budget', async () => {
    const rt = runtime()
    connectorFor(rt, 'worker', { breaker: true })
    connectorFor(rt, 'worker', { breaker: false })
    const budget = processBudget(rt, 'worker')
    expect(processBudget(rt, 'worker')).toBe(budget)
    expect(budget.limit).toBe(CLUSTER_CONNECTIONS.worker)
    // The sixth connection to one cluster waits and then fails; another cluster is unaffected.
    const releases = await Promise.all(
      Array.from({ length: CLUSTER_CONNECTIONS.worker }, () => budget.acquire('cls_a', 50)),
    )
    await expect(budget.acquire('cls_a', 50)).rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' })
    const other = await budget.acquire('cls_b', 50)
    other()
    for (const release of releases) release()
  })

  it('keeps the processes apart and refuses one login for two roles', () => {
    const serve = runtime()
    const worker = runtime()
    expect(processBudget(serve, 'serve')).not.toBe(processBudget(worker, 'worker'))
    expect(processBudget(serve, 'serve').limit).toBe(CLUSTER_CONNECTIONS.serve)
    expect(() => processBudget(serve, 'worker')).toThrow(/one process role/)
  })
})
