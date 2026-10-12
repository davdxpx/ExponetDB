import { newId } from '@exponetdb/kernel'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type PlanAuthority, planAuthorityHolds } from '../src/index.ts'
import { type Enrolled, enrollFirstOwner, type Harness, harness } from './support/flows.ts'

/**
 * The worker's re-check of a running operation's authority (failure case
 * E27): read fresh as `exdb_worker`, from the live role bindings and the
 * applying client's grant. The migration engine's suite shows what a
 * revoked authority stops; this one shows what counts as revoked.
 */
let h: Harness
let owner: Enrolled
let worker: ReturnType<Harness['db']['store']>
const target = newId('tgt', Date.now())

const plan = (over: Partial<PlanAuthority['actor']> = {}): PlanAuthority => ({
  kind: 'migration.apply',
  actor: { kind: 'human', identityId: owner.identityId, clientId: null, ...over },
  subject: { targetId: target, tier: 'prod' },
})

beforeAll(async () => {
  h = await harness('exdb_it_authority')
  owner = await enrollFirstOwner(h)
  worker = h.db.store('exdb_worker')
})

afterAll(async () => {
  await h?.db.drop()
})

describe('the authority of a running operation', () => {
  it('holds for an active identity whose live binding covers the plan', async () => {
    expect(await planAuthorityHolds(worker, plan())).toBe(true)
    // The worker's own plans are not re-checked here.
    expect(
      await planAuthorityHolds(worker, {
        ...plan(),
        actor: { kind: 'system', identityId: null, clientId: null },
      }),
    ).toBe(true)
  })

  it('does not hold without an identity, for an unknown kind, or for a client without a live grant', async () => {
    expect(await planAuthorityHolds(worker, plan({ identityId: null }))).toBe(false)
    expect(await planAuthorityHolds(worker, { ...plan(), kind: 'migration.unknown' })).toBe(false)
    expect(await planAuthorityHolds(worker, plan({ clientId: newId('cli', Date.now()) }))).toBe(
      false,
    )
  })

  it('does not hold once the binding is revoked, and holds again with an active one', async () => {
    await h.withoutGuards(async (c) => {
      await c.query(
        `UPDATE auth.role_bindings SET state = 'revoked', revoked_at = now(), revoke_reason = 'identity_erased'
          WHERE identity_id = $1`,
        [owner.identityId],
      )
    })
    try {
      expect(await planAuthorityHolds(worker, plan())).toBe(false)
    } finally {
      await h.withoutGuards(async (c) => {
        await c.query(
          `UPDATE auth.role_bindings SET state = 'active', revoked_at = NULL, revoke_reason = NULL
            WHERE identity_id = $1`,
          [owner.identityId],
        )
      })
    }
    expect(await planAuthorityHolds(worker, plan())).toBe(true)
  })

  it('does not hold for a disabled identity, whatever its bindings say', async () => {
    await h.withoutGuards(async (c) => {
      await c.query(
        `UPDATE auth.identities SET state = 'disabled', disabled_at = now(), state_changed_at = now()
          WHERE identity_id = $1`,
        [owner.identityId],
      )
    })
    expect(await planAuthorityHolds(worker, plan())).toBe(false)
  })
})
