import { dropDatabase, matrix, testTargets } from '@exponetdb/testkit'
import { describe, expect, it } from 'vitest'
import { documentJson, takeSnapshot } from '../src/index.ts'
import { fp1Vectors } from './golden.ts'
import { open, prepareDatabase } from './targets.ts'

/**
 * The fp1 golden vectors against real PostgreSQL (order §227): each fixture
 * is built in a fresh database on the vector's major and an observer
 * snapshot must yield exactly the stored canonical document and fingerprint.
 * A change of the introspection, the canonical form or the hash that moves
 * any vector fails here; after G4 such a change is `fp2`, never an edit.
 */
describe.each(matrix().map((s) => [s.major, s] as const))(
  'fp1 golden vectors on PostgreSQL %i',
  (major, server) => {
    const vectors = fp1Vectors().filter((v) => v.input.pgMajor === major)

    it('has vectors for this major, built as the superuser they assume', () => {
      expect(vectors.length).toBeGreaterThanOrEqual(4)
      // Owners and ACLs name the superuser that created the objects.
      expect(testTargets().superuser).toBe(vectors[0]?.input.superuser)
    })

    it.each(vectors.map((v) => [v.id, v] as const))(
      '%s reproduces from the catalog',
      async (id, v) => {
        const database = await prepareDatabase(server, `golden_${major}`, {
          name: `golden_${id.replace(/-/g, '_')}`,
          cluster: v.input.roles,
          database: v.input.setup,
        })
        try {
          const s = await open(server, database, 'observer')
          try {
            const snapshot = await takeSnapshot(s, v.input.scope)
            expect(snapshot.complete).toBe(true)
            expect(snapshot.visibility).toEqual([])
            expect(documentJson(snapshot.document)).toEqual(v.expected.document)
            expect(snapshot.fingerprint).toBe(v.expected.fingerprint)
          } finally {
            await s.close()
          }
        } finally {
          await dropDatabase(server, database)
        }
      },
    )
  },
)
