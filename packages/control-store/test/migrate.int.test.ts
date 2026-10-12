import { readFileSync } from 'node:fs'
import { newId } from '@exponetdb/kernel'
import { buildGraph } from '@exponetdb/migrations/graph'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectedMigrations } from '../src/bundles.ts'
import {
  loadBundleSet,
  migrateControlStore,
  readInstallationId,
  schemaState,
} from '../src/index.ts'
import { createTestDatabase, type TestDatabase } from '../src/testing/index.ts'

let db: TestDatabase
let upgraded: TestDatabase

beforeAll(async () => {
  db = await createTestDatabase('exdb_it_migrate')
  upgraded = await createTestDatabase('exdb_it_migrate_g4')
})

afterAll(async () => {
  await db?.drop()
  await upgraded?.drop()
})

/**
 * The shipped set cut to the bundles frozen by the given gates
 * (frozen-bundles.json, `frozenBy`): the Control Store as an installation
 * that ran exactly those releases has it.
 */
async function frozenSet(gates: readonly string[]) {
  const set = await loadBundleSet()
  const frozen = new Set(
    (
      JSON.parse(readFileSync(new URL('../frozen-bundles.json', import.meta.url), 'utf8')) as {
        bundles: { id: string; frozenBy: string }[]
      }
    ).bundles
      .filter((b) => gates.includes(b.frozenBy.split(',')[0] ?? ''))
      .map((b) => b.id),
  )
  const bundles = set.bundles.filter((b) => frozen.has(b.id))
  const graph = buildGraph({
    migrations: bundles.map((b) => ({ id: b.id, dependsOn: b.dependsOn })),
  })
  if (!graph.ok) throw new Error('frozen graph')
  return { ...set, bundles, graph: graph.value }
}

describe('Control Store bootstrap runner (real PostgreSQL 17)', () => {
  it('applies and verifies every shipped bundle from an empty database', async () => {
    const set = await loadBundleSet()
    const store = db.store('exdb_migrate')
    const report = await migrateControlStore({
      store,
      bundles: set,
      engineVersion: 'test',
      newInstallationId: () => newId('ins', Date.now()),
    })
    expect(report.applied).toEqual(set.bundles.map((b) => b.id))
    expect(report.verifications.map((v) => v.status)).toEqual(set.bundles.map(() => 'passed'))
    expect(report.state).toEqual({ status: 'current' })
    expect(report.installationId).toMatch(/^ins_/)
  })

  it('a second run is a no-op and keeps the installation id', async () => {
    const set = await loadBundleSet()
    const store = db.store('exdb_migrate')
    const first = await readInstallationId(db.store('exdb_serve'))
    const report = await migrateControlStore({
      store,
      bundles: set,
      engineVersion: 'test',
      newInstallationId: () => newId('ins', Date.now()),
    })
    expect(report.applied).toEqual([])
    expect(report.verifications).toEqual([])
    expect(report.installationId).toBe(first)
    const state = await schemaState(db.store('exdb_worker'), expectedMigrations(set))
    expect(state).toEqual({ status: 'current' })
  })

  it('upgrades a Control Store at the G4 baseline: only the new bundles run, the data stays', async () => {
    const frozen = await frozenSet(['G2', 'G3A', 'G3B', 'G4'])
    const full = await loadBundleSet()
    expect(frozen.bundles.length).toBe(12)
    const store = upgraded.store('exdb_migrate')
    const baseline = await migrateControlStore({
      store,
      bundles: frozen,
      engineVersion: 'g4',
      newInstallationId: () => newId('ins', Date.now()),
    })
    expect(baseline.state).toEqual({ status: 'current' })
    const installation = await readInstallationId(upgraded.store('exdb_serve'))
    const report = await migrateControlStore({
      store,
      bundles: full,
      engineVersion: 'g5',
      newInstallationId: () => newId('ins', Date.now()),
    })
    const added = full.bundles.filter((b) => !frozen.bundles.some((f) => f.id === b.id))
    expect(added.length).toBeGreaterThan(0)
    expect(report.applied).toEqual(added.map((b) => b.id))
    expect(report.verifications.map((v) => v.status)).toEqual(added.map(() => 'passed'))
    expect(report.state).toEqual({ status: 'current' })
    expect(report.installationId).toBe(installation)
  })
})
