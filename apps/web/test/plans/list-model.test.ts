import type { MigrationBundle, PlanView } from '@exponetdb/sdk/operations'
import { describe, expect, it } from 'vitest'
import {
  awaitingQueryOf,
  isPlanListFiltered,
  planListHref,
  planListQueryOf,
  planListSearch,
} from '../../src/features/plans/list-model.ts'
import { matchRevision, planBundlesOf } from '../../src/features/plans/stored-files.tsx'
import { canOfferWithdraw } from '../../src/features/plans/withdraw-action.tsx'
import {
  BUNDLE_DIGEST,
  hostilePlan,
  IDENTITY,
  MIGRATION,
  OTHER_IDENTITY,
  PROJECT,
} from './support.tsx'

describe('the plan list search', () => {
  it('keeps allowlisted and well-formed values', () => {
    expect(
      planListSearch({
        state: 'withdrawn',
        kind: 'migration.apply',
        actor: 'self',
        target: 'shop/platform/staging',
      }),
    ).toEqual({
      state: 'withdrawn',
      kind: 'migration.apply',
      actor: 'self',
      target: 'shop/platform/staging',
      awaiting: undefined,
    })
    expect(planListSearch({ target: 'tgt_01M4S9000000000000000000AC' }).target).toBe(
      'tgt_01M4S9000000000000000000AC',
    )
  })

  it('drops hostile values and always returns every key', () => {
    const search = planListSearch({
      state: 'pending',
      kind: `migration.apply${'x'.repeat(60)}`,
      actor: 'any',
      target: '../../etc',
      awaiting: 'yes',
      extra: '<script>',
    })
    expect(search).toEqual({
      state: undefined,
      kind: undefined,
      actor: undefined,
      target: undefined,
      awaiting: undefined,
    })
    expect(Object.keys(search).sort()).toEqual(['actor', 'awaiting', 'kind', 'state', 'target'])
    expect(planListSearch({ kind: 'Migration.Apply' }).kind).toBeUndefined()
    expect(planListSearch({ state: ['active'] }).state).toBeUndefined()
  })

  it('drops a plan state together with "awaiting approval" (those plans are accepted for apply)', () => {
    expect(planListSearch({ state: 'active', awaiting: 'approval' })).toMatchObject({
      state: undefined,
      awaiting: 'approval',
    })
  })

  it('builds the queries of GET /plans and of the awaiting view', () => {
    const search = planListSearch({ state: 'active', kind: 'migration.apply', actor: 'self' })
    expect(planListQueryOf(search)).toEqual({
      state: 'active',
      kind: 'migration.apply',
      actor: 'self',
    })
    expect(planListQueryOf({})).toEqual({ actor: 'any' })
    expect(awaitingQueryOf({ kind: 'migration.apply' })).toEqual({
      state: 'awaiting_approval',
      kind: 'migration.apply',
      actor: 'any',
    })
    expect(isPlanListFiltered({})).toBe(false)
    expect(isPlanListFiltered({ awaiting: 'approval' })).toBe(true)
  })

  it('writes an address with the checked keys only', () => {
    expect(planListHref({})).toBe('/changes/plans')
    expect(planListHref({ actor: 'self', awaiting: 'approval' })).toBe(
      '/changes/plans?actor=self&awaiting=approval',
    )
    expect(planListHref({ kind: '../x' } as never)).toBe('/changes/plans')
  })
})

describe('the bundles of a plan and the stored revision it runs', () => {
  it('reads the project and the bundles of a migration plan, dropping malformed ids', () => {
    const plan = hostilePlan()
    expect(planBundlesOf(plan)).toEqual({
      projectId: PROJECT,
      items: [{ migrationId: MIGRATION, name: 'add­notes', revision: 1, bundleDigest: null }],
    })
    const hostile = {
      ...plan,
      change: {
        ...plan.change,
        content: { projectId: '../x', migrations: [{ migrationId: MIGRATION, revision: 1 }] },
      },
    } as PlanView
    expect(planBundlesOf(hostile)).toBeUndefined()
    const badItems = {
      ...plan,
      change: {
        ...plan.change,
        content: {
          projectId: PROJECT,
          migrations: [
            { migrationId: '../x', revision: 1 },
            { migrationId: MIGRATION, revision: -1 },
          ],
        },
      },
    } as PlanView
    expect(planBundlesOf(badItems)?.items).toEqual([
      { migrationId: MIGRATION, name: null, revision: null, bundleDigest: null },
    ])
    expect(
      planBundlesOf({ ...plan, kind: 'target.register' } as unknown as PlanView),
    ).toBeUndefined()
  })

  it('matches the revision by number and digest; nothing matches without either', () => {
    const stored = {
      revisions: [
        { revision: 1, bundleDigest: BUNDLE_DIGEST },
        { revision: 2, bundleDigest: `sha256:c1:${'77'.repeat(32)}` },
      ],
    } as unknown as MigrationBundle
    const item = { migrationId: MIGRATION, name: null }
    expect(matchRevision(stored, { ...item, revision: 1, bundleDigest: null })).toBe(1)
    expect(matchRevision(stored, { ...item, revision: 1, bundleDigest: BUNDLE_DIGEST })).toBe(1)
    expect(
      matchRevision(stored, { ...item, revision: 2, bundleDigest: BUNDLE_DIGEST }),
    ).toBeUndefined()
    expect(matchRevision(stored, { ...item, revision: null, bundleDigest: BUNDLE_DIGEST })).toBe(1)
    expect(matchRevision(stored, { ...item, revision: null, bundleDigest: null })).toBeUndefined()
  })
})

describe('withdraw is offered on the person’s own active plan only', () => {
  it('follows the contract: own, active and made in the Web App', () => {
    const own = { state: 'active', actor: { identityId: IDENTITY, kind: 'human', via: 'web' } }
    expect(canOfferWithdraw(own as PlanView, IDENTITY)).toBe(true)
    expect(canOfferWithdraw({ ...own, state: 'consumed' } as PlanView, IDENTITY)).toBe(false)
    expect(
      canOfferWithdraw(
        { ...own, actor: { ...own.actor, identityId: OTHER_IDENTITY } } as PlanView,
        IDENTITY,
      ),
    ).toBe(false)
    expect(
      canOfferWithdraw({ ...own, actor: { ...own.actor, identityId: null } } as PlanView, IDENTITY),
    ).toBe(false)
    // The server binds a withdrawal to the plan's client: an agent's or the CLI's plan is
    // withdrawn there, so the Web App does not offer a button the server would refuse.
    for (const via of ['mcp', 'cli', 'rest', 'ci']) {
      expect(
        canOfferWithdraw({ ...own, actor: { ...own.actor, via } } as PlanView, IDENTITY),
      ).toBe(false)
    }
  })
})
