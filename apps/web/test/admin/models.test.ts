import { describe, expect, it } from 'vitest'
import { toBindingScope } from '../../src/features/access/people-model.ts'
import { exportFileName, exportHeader } from '../../src/features/audit/download.ts'
import { eventLinks } from '../../src/features/audit/event-model.ts'
import { auditHref, auditSearch, filterProblem } from '../../src/features/audit/search.ts'
import { noteProblem } from '../../src/features/settings/break-glass-model.ts'
import { changeOf, evidenceChains } from '../../src/features/settings/environment-model.ts'
import {
  installationParams,
  parseColumns,
  parseParams,
  targetParams,
} from '../../src/features/settings/policy-model.ts'
import { safeReturnTo } from '../../src/lib/navigation/links.ts'
import { GLOBAL_NAV } from '../../src/shell/navigation.ts'
import { dataReadRule, environment, event } from './fixtures.ts'
import { CLIENT, T0, TARGET } from './support.tsx'

describe('audit search parameters', () => {
  it('keep exact shapes only', () => {
    expect(
      auditSearch({
        actor: 'self',
        client: CLIENT,
        grant: 'grt_x',
        result: 'denied',
        target: `${TARGET}\n`,
        action: 'migration.apply',
        from: '2026-10-13T09:00:00Z',
        to: '2026-13-45T99:00:00Z',
      }),
    ).toEqual({
      actor: 'self',
      client: CLIENT,
      result: 'denied',
      target: TARGET,
      action: 'migration.apply',
      from: '2026-10-13T09:00:00Z',
    })
    expect(auditSearch({ actor: 'admin', action: 'DROP TABLE x', target: '../etc' })).toEqual({})
    expect(auditSearch({ action: `${'a.'.repeat(40)}b` })).toEqual({})
    expect(filterProblem('client', 'cli_short')).toBe('shape')
    expect(filterProblem('client', '')).toBeUndefined()
  })

  it('build the address in a fixed order from checked values only', () => {
    expect(auditHref({ result: 'failed', actor: 'self' })).toBe('/audit?actor=self&result=failed')
    expect(auditHref({ client: 'https://evil.example' } as never)).toBe('/audit')
    expect(auditHref({})).toBe('/audit')
  })
})

describe('audit event links', () => {
  it('go only to allowlisted app pages built from typed ids', () => {
    expect(eventLinks(event())).toEqual({
      plan: '/changes/plans/pln_01JZ0000000000000000000001',
      operation: '/changes/operations/op_01JZ0000000000000000000001',
      ledger: '/t/shop/app/production/migrations',
    })
    expect(
      eventLinks(
        event({
          action: 'oauth.grant.revoke',
          refs: { jobId: null, operationId: null, planHash: null, planId: null },
        }),
      ),
    ).toEqual({})
    expect(
      eventLinks(
        event({
          subject: {
            clusterId: null,
            nodeId: null,
            targetId: null,
            targetPath: 'Shop/../x',
            tier: null,
          },
          refs: { jobId: null, operationId: '//evil', planHash: null, planId: 'pln_../../x' },
        }),
      ),
    ).toEqual({})
  })
})

describe('the export header', () => {
  const header = (over: Record<string, unknown>) =>
    `${JSON.stringify({ type: 'header', format: 'exponetdb.audit-export/v1', count: 2, firstSeq: 1, lastSeq: 2, more: true, nextCursor: 'abc', ...over })}\n{"type":"event"}\n`

  it('is read from the first line only, with a cursor of the expected shape', () => {
    expect(exportHeader(header({}))).toEqual({
      firstSeq: 1,
      lastSeq: 2,
      count: 2,
      more: true,
      nextCursor: 'abc',
    })
    expect(exportHeader(header({ nextCursor: '../x y' }))?.more).toBe(false)
    expect(exportHeader(header({ format: 'other' }))).toBeUndefined()
    expect(exportHeader('not json')).toBeUndefined()
    expect(
      exportFileName({ firstSeq: 5, lastSeq: 9, count: 5, more: false, nextCursor: null }),
    ).toBe('exponetdb-audit-5-9.ndjson')
    expect(
      exportFileName({ firstSeq: null, lastSeq: null, count: 0, more: false, nextCursor: null }),
    ).toBe('exponetdb-audit-empty.ndjson')
  })
})

describe('the break-glass review note', () => {
  it('follows the contract: 1 to 2000 characters, not blank, line feeds only', () => {
    expect(noteProblem('')).toBe('blank')
    expect(noteProblem(' \n ')).toBe('blank')
    expect(noteProblem('x'.repeat(2000))).toBeUndefined()
    expect(noteProblem('x'.repeat(2001))).toBe('long')
    expect(noteProblem('line\nline')).toBeUndefined()
    expect(noteProblem('cr\r')).toBe('characters')
    expect(noteProblem('nul\u0000')).toBe('characters')
    expect(noteProblem('bidi‮')).toBe('characters')
    expect(noteProblem('isolate⁧')).toBe('characters')
    expect(noteProblem('c1\u0085')).toBe('characters')
  })
})

describe('role binding scopes', () => {
  it('take an id of the kind prefix and shape only', () => {
    expect(toBindingScope('global', 'ignored')).toEqual({ kind: 'global' })
    expect(toBindingScope('target', ` ${TARGET} `)).toEqual({ kind: 'target', targetId: TARGET })
    expect(toBindingScope('product', TARGET)).toBeUndefined()
    expect(toBindingScope('environment', 'env_short')).toBeUndefined()
  })
})

describe('policy settings', () => {
  it('resolve installation and target parameters from the latest revisions', () => {
    const rule = dataReadRule({
      settings: [
        {
          createdAt: T0,
          operationId: null,
          params: { mode: 'enabled' },
          revision: 1,
          scopeId: 'installation',
          scopeKind: 'installation',
        },
        {
          createdAt: T0,
          operationId: null,
          params: { mode: 'humans_only' },
          revision: 2,
          scopeId: 'installation',
          scopeKind: 'installation',
        },
        {
          createdAt: T0,
          operationId: null,
          params: { sensitiveColumns: ['a.b.c'] },
          revision: 1,
          scopeId: TARGET,
          scopeKind: 'target',
        },
      ],
    })
    expect(installationParams(rule)).toEqual({ mode: 'humans_only', sensitiveColumns: [] })
    expect(targetParams(rule, TARGET)).toEqual({ mode: 'humans_only', sensitiveColumns: ['a.b.c'] })
  })

  it('check column patterns and parameter objects', () => {
    expect(parseColumns('public.users.email\n\n*.*.ssn\npublic.users.email')).toEqual({
      ok: true,
      columns: ['public.users.email', '*.*.ssn'],
    })
    expect(parseColumns('users.email')).toEqual({ ok: false, line: 'users.email' })
    expect(parseParams('{"mode":"by_tier"}')).toEqual({ mode: 'by_tier' })
    expect(parseParams('[1]')).toBeUndefined()
    expect(parseParams('{"1bad":1}')).toBeUndefined()
    expect(parseParams('nope')).toBeUndefined()
  })
})

describe('environments', () => {
  it('derive the evidence chain and the fields that changed', () => {
    const dev = environment({ slug: 'development', rank: 0, id: 'env_01JZ0000000000000000000002' })
    const staging = environment({ evidenceFrom: 'development' })
    const prod = environment({
      slug: 'production',
      rank: 20,
      tier: 'prod',
      evidenceFrom: 'staging',
      id: 'env_01JZ0000000000000000000003',
    })
    expect(evidenceChains([prod, staging, dev])).toEqual([['development', 'staging', 'production']])
    // A loop ends where it would repeat.
    const a = environment({ slug: 'a', evidenceFrom: 'b' })
    const b = environment({ slug: 'b', evidenceFrom: 'a', id: 'env_01JZ0000000000000000000009' })
    expect(evidenceChains([a, b])).toEqual([])
    expect(
      changeOf(staging, {
        displayName: 'Staging',
        tier: 'nonprod',
        evidenceFrom: 'development',
        rank: '10',
      }),
    ).toEqual({})
    expect(
      changeOf(staging, { displayName: ' Stage ', tier: 'prod', evidenceFrom: '', rank: '11' }),
    ).toEqual({
      displayName: 'Stage',
      tier: 'prod',
      evidenceFrom: null,
      rank: 11,
    })
  })
})

describe('navigation', () => {
  it('lists break-glass under settings for policy.manage, as a safe return target', () => {
    const item = GLOBAL_NAV.find((entry) => entry.id === 'break-glass')
    expect(item).toMatchObject({
      path: '/settings/break-glass',
      section: 'settings',
      requires: ['permission:policy.manage'],
    })
    expect(safeReturnTo('/settings/break-glass')).toBe('/settings/break-glass')
    expect(safeReturnTo('/settings/break-glass/x')).toBe('/account')
  })
})
