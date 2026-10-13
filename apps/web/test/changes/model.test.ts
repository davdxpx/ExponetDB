import { ERRORS } from '@exponetdb/contracts'
import { describe, expect, it } from 'vitest'
import {
  errorTextKey,
  OPERATION_ERROR_TEXT,
  operationPath,
  operationPollInterval,
  operationPolling,
  operationsQueryOf,
  operationsSearch,
  promotionPath,
  promotionSearch,
  timelineOf,
  verifyAgainRung,
} from '../../src/features/changes/model.ts'
import { en } from '../../src/lib/i18n/en.ts'
import { operationFor, stream } from './support.tsx'

const OP = 'op_01M4S9000000000000000000AA'
const PRJ = 'prj_01M4S9000000000000000000AF'

describe('the search of the operations list', () => {
  it('keeps only allowlisted states, kind grammar and actor self', () => {
    expect(
      operationsSearch({ state: 'needs_attention', kind: 'migration.apply', actor: 'self' }),
    ).toEqual({ state: 'needs_attention', kind: 'migration.apply', actor: 'self' })
    for (const hostile of [
      { state: '<script>' },
      { state: 'running ' },
      { kind: 'Migration.Apply' },
      { kind: 'migration.apply‮' },
      { kind: 'migration apply' },
      { kind: `a${'.b'.repeat(10)}` },
      { kind: 'x'.repeat(81) },
      { kind: 42 },
      { actor: 'any' },
      { actor: 'SELF' },
    ]) {
      expect(operationsSearch(hostile), JSON.stringify(hostile)).toEqual({
        state: undefined,
        kind: undefined,
        actor: undefined,
      })
    }
  })

  it('sends actor=any by default and only the filters that are set', () => {
    expect(operationsQueryOf({})).toEqual({ actor: 'any' })
    expect(operationsQueryOf({ state: 'running', actor: 'self' })).toEqual({
      state: 'running',
      actor: 'self',
    })
  })
})

describe('paths of the Changes screens', () => {
  it('builds operation and promotion paths from valid ids only', () => {
    expect(operationPath(OP)).toBe(`/changes/operations/${OP}`)
    for (const bad of ['op_x', `${OP}/../x`, 'pln_01M4S9000000000000000000AA', null, 7]) {
      expect(operationPath(bad)).toBeUndefined()
    }
    expect(promotionPath(PRJ)).toBe(`/changes/promotion?project=${PRJ}`)
    expect(promotionPath('prj_../x')).toBeUndefined()
    expect(promotionSearch({ project: PRJ })).toEqual({ project: PRJ })
    expect(promotionSearch({ project: `${PRJ}&x=1` })).toEqual({ project: undefined })
  })
})

describe('the polling of an operation', () => {
  const now = Date.parse('2026-10-13T08:10:00.000Z')
  const at = (state: string, updatedAt = '2026-10-13T08:09:50.000Z') =>
    ({ state, updatedAt }) as Parameters<typeof operationPollInterval>[0]

  it('stops for terminal operations', () => {
    for (const state of ['succeeded', 'failed', 'verification_failed', 'canceled']) {
      expect(operationPollInterval(at(state), 0, now), state).toBe(false)
    }
  })

  it('asks often while at work, less once quiet, rarely while waiting, and backs off on failures', () => {
    expect(operationPollInterval(at('running'), 0, now)).toBe(operationPolling.activeMs)
    expect(operationPollInterval(at('verifying', '2026-10-13T08:00:00.000Z'), 0, now)).toBe(
      operationPolling.slowMs,
    )
    expect(operationPollInterval(at('needs_attention'), 0, now)).toBe(operationPolling.waitingMs)
    expect(operationPollInterval(at('running'), 1, now)).toBe(operationPolling.activeMs * 2)
    expect(operationPollInterval(at('running'), 50, now)).toBe(operationPolling.maxMs)
    expect(operationPollInterval(undefined, 0, now)).toBe(operationPolling.activeMs)
  })
})

describe('the confirmation of Verify again', () => {
  const facts = {
    planHash: 'sha256:ph1:ab',
    tier: 'prod' as const,
    planClass: 'high' as const,
    targetPath: 'shop/platform/production',
  }

  it('is plain on non-production, the plan confirmation on production, typed without the plan', () => {
    expect(
      verifyAgainRung(
        operationFor(OP, { subject: { ...operationFor(OP).subject, tier: 'nonprod' } }),
        facts,
      ),
    ).toEqual({ kind: 'confirm' })
    expect(verifyAgainRung(operationFor(OP), facts)).toEqual({ kind: 'plan', facts })
    expect(verifyAgainRung(operationFor(OP), undefined)).toEqual({
      kind: 'typed',
      targetPath: 'shop/platform/production',
    })
    // A missing tier is production (fails closed).
    expect(
      verifyAgainRung(
        operationFor(OP, { subject: { ...operationFor(OP).subject, tier: null } }),
        undefined,
      ).kind,
    ).toBe('typed')
  })
})

describe('the catalog text of operation error codes', () => {
  it('is the contract catalog text, word for word', () => {
    const errors = ERRORS as Readonly<Record<string, { readonly message: string }>>
    for (const [code, key] of Object.entries(OPERATION_ERROR_TEXT)) {
      expect(errors[code], code).toBeDefined()
      expect(en[key], code).toBe(errors[code]?.message)
    }
    expect(errorTextKey('NOT_A_CODE')).toBeUndefined()
    expect(errorTextKey('__proto__')).toBeUndefined()
  })
})

describe('the promotion stream as timeline data', () => {
  it('orders environments by rank, keeps an absent cell absent and shows divergent as drifted', () => {
    const data = timelineOf(stream())
    expect(data.environments.map((e) => e.id)).toEqual(['staging', 'production'])
    const add = data.bundles.find((b) => b.slug === 'add_notes')
    expect(add?.cells.map((c) => c.environmentId)).toEqual(['staging'])
    const create = data.bundles.find((b) => b.slug === 'create_accounts')
    expect(create?.cells.map((c) => [c.environmentId, c.state])).toEqual([
      ['staging', 'verified'],
      ['production', 'drifted'],
    ])
    expect(create?.cells[0]?.at).toBe('2026-10-12T08:02:00.000Z')
    expect(data.totalBundleCount).toBeUndefined()
    expect(timelineOf(stream({ truncated: true, bundleCount: 1200 })).totalBundleCount).toBe(1200)
  })

  it('maps a state this build does not know to unknown, never to not applied', () => {
    const s = stream()
    const odd = {
      ...s,
      bundles: [
        {
          ...s.bundles[0],
          states: [{ ...s.bundles[0]?.states[0], state: 'something_new' }],
        },
      ],
    } as unknown as Parameters<typeof timelineOf>[0]
    expect(timelineOf(odd).bundles[0]?.cells[0]?.state).toBe('unknown')
  })
})
