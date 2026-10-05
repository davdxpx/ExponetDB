import { newId } from '@exponetdb/kernel'
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

beforeAll(async () => {
  db = await createTestDatabase('exdb_it_migrate')
})

afterAll(async () => {
  await db?.drop()
})

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
})
