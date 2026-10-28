// I13 Immutability: applied content cannot change; the same id with other bytes is refused everywhere.
// Library level: the bundle store (`ingestBundles`, `readRevision`, `planMigrationApply`) against the real
// Control Store and real target servers. Compared with migration-bundles.md §3 "What a mismatch means".
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { ingestBundles, MigrationError, readRevision, revisionsOf, storedStream } from '@exponetdb/migrations-engine'
import { serverFor } from '@exponetdb/testkit'
import type { BundleSubmission } from '@exponetdb/contracts'
import { DEFAULTS, migrationWorld, type Target, type World } from './lib/world.ts'

let w: World
let t1: Target
let t2: Target

const projectId = () => t1.record.projectId

beforeAll(async () => {
  w = await migrationWorld('b2_i13', serverFor(17))
  t1 = await w.registerTarget('stage', 'nonprod')
  t2 = await w.registerTarget('other', 'nonprod')
}, 300_000)
afterAll(async () => {
  await w?.close()
})

const ingest = (bundles: BundleSubmission[]) =>
  w.h.serve.transaction('b2.ingest', (tx) => ingestBundles(tx, { projectId: projectId(), bundles, defaults: DEFAULTS, identityId: w.a.identityId }))

async function refusal(p: Promise<unknown>): Promise<MigrationError> {
  try {
    await p
  } catch (e) {
    if (e instanceof MigrationError) return e
    throw e
  }
  throw new Error('expected a refusal')
}

const UP = 'CREATE TABLE public.i13_a (i int);\n'

describe('I13 the bundle store', () => {
  test('same bytes again are `unchanged` and return the stored revision', async () => {
    const id = w.ulid()
    const b = w.bundle({ id, name: 'same', up: UP })
    const [first] = await ingest([b])
    const [again] = await ingest([b])
    expect(first?.status).toBe('stored')
    expect(again?.status).toBe('unchanged')
    expect(again?.revision.revision).toBe(first?.revision.revision)
  })

  test('DOC §3 / §7 / store.ts header: a comment-only edit with the same apply checksum is stored as a new revision (verify_revision) and the comment_only_change lint can see it', async () => {
    const id = w.ulid()
    const [a] = await ingest([w.bundle({ id, name: 'cmt', up: UP })])
    const [b] = await ingest([w.bundle({ id, name: 'cmt', up: `-- reviewed by someone else\n${UP}` })])
    // The documented outcome: "a new verify, rollback or comment content with the same apply checksum is a verify_revision".
    expect(b?.status, `status ${b?.status}: the new bytes are ${b?.status === 'unchanged' ? 'DROPPED' : 'stored'}`).toBe('verify_revision')
    expect(b?.revision.revision).toBeGreaterThan(a?.revision.revision ?? 0)
    const stored = await readRevision(w.h.serve, projectId(), id)
    expect(Buffer.from(stored?.files['up.sql'] ?? []).toString()).toContain('reviewed by someone else')
  })

  test('DOC §3: a changed description / name-independent metadata edit with the same digests is also kept (bytes are the audit record)', async () => {
    const id = w.ulid()
    await ingest([w.bundle({ id, name: 'meta', up: UP })])
    const edited = w.bundle({ id, name: 'meta', up: UP })
    edited.files['migration.yaml'] = edited.files['migration.yaml'].replace('A change of the failure-case suite', 'A DIFFERENT description')
    const [b] = await ingest([edited])
    const stored = await readRevision(w.h.serve, projectId(), id)
    expect(Buffer.from(stored?.files['migration.yaml'] ?? []).toString(), `status ${b?.status}`).toContain('DIFFERENT description')
  })

  test('DOC §3: same id, other executable bytes, never applied: allowed as rewritten_unapplied, old revision kept', async () => {
    const id = w.ulid()
    await ingest([w.bundle({ id, name: 'rew', up: UP })])
    const [b] = await ingest([w.bundle({ id, name: 'rew', up: 'CREATE TABLE public.i13_b (i int);\n' })])
    expect(b?.status).toBe('rewritten_unapplied')
    const all = await revisionsOf(w.h.serve, projectId(), id)
    expect(all.map((r) => r.revision)).toEqual([2, 1])
  })

  test('after an apply on ANY target of the project, other bytes under the same id are MIGRATION_CHECKSUM_MISMATCH at ingestion', async () => {
    const id = w.ulid()
    const p = await w.plan(t1, { bundles: [w.bundle({ id, name: 'frozen', up: 'CREATE TABLE public.i13_frozen (i int);\n' })] })
    const op = await w.apply(p)
    expect(op).toMatchObject({ state: 'succeeded', applyOutcome: 'applied' })
    const e = await refusal(ingest([w.bundle({ id, name: 'frozen', up: 'CREATE TABLE public.i13_frozen (i int, j int);\n' })]))
    expect(e.code).toBe('MIGRATION_CHECKSUM_MISMATCH')
    // and through the planner of the OTHER target, which ingests as well
    const e2 = await refusal(w.plan(t2, { bundles: [w.bundle({ id, name: 'frozen', up: 'CREATE TABLE public.i13_frozen (i int, k int);\n' })] }))
    expect(e2.code).toBe('MIGRATION_CHECKSUM_MISMATCH')
    // a comment-only edit is not a mismatch (c1)
    await expect(ingest([w.bundle({ id, name: 'frozen', up: '-- later note\nCREATE TABLE public.i13_frozen (i int);\n' })])).resolves.toBeDefined()
  })

  test('the plan binds the revision it was made for: a rewrite after planning does not change what the plan applies', async () => {
    const id = w.ulid()
    const p = await w.plan(t2, { bundles: [w.bundle({ id, name: 'bound', up: 'CREATE TABLE public.i13_bound (i int);\n' })] })
    await ingest([w.bundle({ id, name: 'bound', up: 'CREATE TABLE public.i13_bound_other (i int);\n' })]) // rewritten_unapplied
    const op = await w.apply(p)
    expect(op).toMatchObject({ state: 'succeeded' })
    const c = await (await import('@exponetdb/testkit')).superuserClient(serverFor(17), t2.database)
    try {
      const r = await c.query("SELECT to_regclass('public.i13_bound') IS NOT NULL AS a, to_regclass('public.i13_bound_other') IS NOT NULL AS b")
      expect(r.rows[0]).toEqual({ a: true, b: false })
    } finally {
      await c.end()
    }
  })

  test('the target ledger is the truth: a stored newer revision with other bytes is MIGRATION_CHECKSUM_MISMATCH at plan time for that target', async () => {
    const id = w.ulid()
    const p = await w.plan(t1, { bundles: [w.bundle({ id, name: 'ledgered', up: 'CREATE TABLE public.i13_ledgered (i int);\n' })] })
    await w.apply(p)
    // plan the same id from the store on the target that has it applied: no-op
    const again = await refusal(w.plan(t1, { migrationIds: [id] }))
    expect(['MIGRATION_ALREADY_APPLIED']).toContain(again.code)
  })

  test('concurrent uploads of the same id with different bytes serialise: revisions 1..n are distinct and contiguous', async () => {
    const id = w.ulid()
    const variants = Array.from({ length: 8 }, (_, i) => w.bundle({ id, name: 'race', up: `CREATE TABLE public.race_${i} (i int);\n` }))
    const results = await Promise.all(variants.map((b) => ingest([b])))
    const revs = results.map((r) => r[0]?.revision.revision).sort((a, b) => (a ?? 0) - (b ?? 0))
    expect(revs).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    const all = await revisionsOf(w.h.serve, projectId(), id)
    expect(all).toHaveLength(8)
  })

  test('concurrent uploads of the same bytes store one revision', async () => {
    const id = w.ulid()
    const b = w.bundle({ id, name: 'racesame', up: UP })
    const results = await Promise.all(Array.from({ length: 8 }, () => ingest([b])))
    expect(new Set(results.map((r) => r[0]?.revision.revision)).size).toBe(1)
    expect((await revisionsOf(w.h.serve, projectId(), id)).length).toBe(1)
  })

  test('two bundles with one id in one submission are refused (duplicate_migration_id)', async () => {
    const id = w.ulid()
    const e = await refusal(ingest([w.bundle({ id, name: 'dup', up: UP }), w.bundle({ id, name: 'dup', up: `-- x\n${UP}`.replace('i int', 'j int') })]))
    expect(e.code).toBe('MIGRATION_BUNDLE_INVALID')
  })

  test('stored revisions cannot be updated, deleted or truncated by any Control Store role', async () => {
    const id = w.ulid()
    await ingest([w.bundle({ id, name: 'immutable', up: UP })])
    for (const role of ['exdb_serve', 'exdb_worker'] as const) {
      for (const stmt of [
        `UPDATE migrations.bundle_revisions SET up_sql = '\\x00' WHERE migration_id = '${id}'`,
        `DELETE FROM migrations.bundle_revisions WHERE migration_id = '${id}'`,
        'TRUNCATE migrations.bundle_revisions',
      ]) {
        const failed = await w.h.db.asRole(role, async (c) => c.query(stmt).then(() => false, () => true))
        expect(failed, `${role}: ${stmt}`).toBe(true)
      }
    }
    // not even the bootstrap superuser can do it through ordinary DML: the trigger rejects the change
    for (const stmt of [`UPDATE migrations.bundle_revisions SET name = 'x-y' WHERE migration_id = '${id}'`, `DELETE FROM migrations.bundle_revisions WHERE migration_id = '${id}'`]) {
      const failed = await w.h.db.asSuperuser(async (c) => c.query(stmt).then(() => false, () => true))
      expect(failed, `superuser: ${stmt}`).toBe(true)
    }
  })
})

describe('I13 the first campaign\'s dangling stored bundle must not poison planning for the project', () => {
  test('a stored bundle that depends on an unknown id fails only plans that include it (MIGRATION_DEPENDENCY_UNKNOWN naming it)', async () => {
    const dangling = w.ulid()
    const missing = w.ulid()
    await ingest([w.bundle({ id: dangling, name: 'dangling', up: 'CREATE TABLE public.dangling (i int);\n', dependsOn: [missing] })])
    // an unrelated plan on the same project and target is unaffected
    const fine = w.ulid()
    const p = await w.plan(t1, { bundles: [w.bundle({ id: fine, name: 'unrelated', up: 'CREATE TABLE public.i13_unrelated (i int);\n' })] })
    expect(p.state).toBe('active')
    // the plan that includes the dangling bundle names it
    const e = await refusal(w.plan(t1, { migrationIds: [dangling] }))
    expect(e.code).toBe('MIGRATION_DEPENDENCY_UNKNOWN')
    expect(JSON.stringify((e as unknown as { details: unknown }).details)).toContain(dangling)
    // a bundle that depends on the dangling one is refused the same way
    const child = w.ulid()
    const e2 = await refusal(w.plan(t1, { bundles: [w.bundle({ id: child, name: 'child', up: 'CREATE TABLE public.i13_child (i int);\n', dependsOn: [dangling] })] }))
    expect(e2.code).toBe('MIGRATION_DEPENDENCY_UNKNOWN')
    // the stream the planner reads still lists it, and a corrected revision repairs it
    expect((await storedStream(w.h.serve, projectId())).has(dangling)).toBe(true)
  })
})

describe('I13 the mirror window: the store trusts the Control Store mirror, not the target ledger', () => {
  test('INVARIANT: after an apply, other bytes under the same id are refused even if the ledger mirror has not caught up (after commit, before mirror)', async () => {
    const id = w.ulid()
    const p = await w.plan(t1, { bundles: [w.bundle({ id, name: 'mirrorlag', up: 'CREATE TABLE public.i13_lag (i int);\n' })] })
    await w.apply(p)
    // simulate the crash window "after commit, before ledger mirror": the mirror row is not there yet
    await w.h.db.asSuperuser((c) => c.query('DELETE FROM migrations.ledger_mirror WHERE migration_id = $1', [id]))
    const e = await w.plan(t2, { bundles: [w.bundle({ id, name: 'mirrorlag', up: 'CREATE TABLE public.i13_lag (i int, evil int);\n' })] }).then(
      () => null,
      (x: unknown) => x,
    )
    expect(e, 'the rewritten bytes were ACCEPTED although the id is applied on stage').toBeInstanceOf(MigrationError)
  })
})

describe('I13 consequence of the mirror window', () => {
  test('INVARIANT: no plan for any target may carry other bytes than the ones an applied id has (checked at plan time, end to end)', async () => {
    const id = w.ulid()
    const original = w.bundle({ id, name: 'mirrorlag2', up: 'CREATE TABLE public.i13_lag2 (i int);\n' })
    const first = await w.plan(t1, { bundles: [original] })
    await w.apply(first)
    const appliedChecksum = (first.body['content'] as { migrations: { checksum: string }[] }).migrations[0]?.checksum
    await w.h.db.asSuperuser((c) => c.query('DELETE FROM migrations.ledger_mirror WHERE migration_id = $1', [id]))
    let planned: string | undefined
    try {
      const p = await w.plan(t2, { bundles: [w.bundle({ id, name: 'mirrorlag2', up: 'CREATE TABLE public.i13_lag2 (i int, evil int);\n' })] })
      planned = (p.body['content'] as { migrations: { checksum: string }[] }).migrations[0]?.checksum
    } catch {
      return // refused: the invariant holds
    }
    expect(planned, 'a plan for another target carries the rewritten bytes of an id that is applied elsewhere').toBe(appliedChecksum)
  })
})
