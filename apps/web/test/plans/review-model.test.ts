import type { ApprovalReview } from '@exponetdb/sdk/operations'
import { describe, expect, it } from 'vitest'
import { reviewModel } from '../../src/features/plans/review-model.ts'

const MIGRATION = '01M4S9000000000000000000AB'
const SHY = String.fromCodePoint(0x00ad)
const UP = 'ALTER TABLE public.accounts ADD COLUMN notes text;'
const VERIFY = 'SELECT count(*) = 1 AS ok FROM information_schema.columns;'

const source = (file: string, text: string) => ({
  migrationId: MIGRATION,
  revision: 1,
  file,
  text,
  bytes: text.length,
  truncated: false,
})

function review(sources: unknown[], overrides: Record<string, unknown> = {}): ApprovalReview {
  return {
    clientName: `Agent${SHY}Official`,
    sources,
    plan: {
      kind: 'migration.apply',
      class: 'high',
      decision: 'require',
      requirements: [{ kind: 'approval', count: 1 }],
      policyRules: [
        {
          id: 'evidence.staging',
          severity: 'error',
          result: 'pass',
          message: 'Verified on staging.',
        },
      ],
      planHash: `sha256:ph1:${'ab'.repeat(32)}`,
      expiresAt: '2026-10-13T09:00:00.000Z',
      actor: { identityId: 'idn_01M4S9000000000000000000AD', kind: 'human', via: 'mcp' },
      subject: { targetPath: 'shop/platform/production', tier: 'prod' },
      change: {
        content: {
          migrations: [
            {
              migrationId: MIGRATION,
              name: `add${SHY}notes`,
              checksum: `sha256:c1:${'ef'.repeat(32)}`,
            },
          ],
          facts: { evidence: 'present' },
          expectedState: { schemaFingerprint: `sha256:fp1:${'01'.repeat(32)}` },
        },
        analysis: {
          perMigration: [
            {
              migrationId: MIGRATION,
              statements: [
                {
                  line: 1,
                  index: 0,
                  kind: 'ALTER TABLE',
                  lock: { mode: 'ACCESS EXCLUSIVE' },
                  compatibility: 'additive',
                },
              ],
              compatibility: { declared: 'additive', observed: 'destructive', agreement: false },
              destructive: [`table public.acc${SHY}ounts`],
              lockSeverity: 'blocking',
              rewriteRisk: [{ relation: 'public.big', rows: 10, bytes: 100 }],
              rollback: { available: false, declaredSafety: null },
            },
          ],
          summary: { compatibility: 'destructive', lockSeverity: 'blocking', destructive: true },
        },
      },
      ...overrides,
    },
  } as unknown as ApprovalReview
}

describe('the plan review model', () => {
  it('keeps every foreign string raw for the untrusted-text renderer', () => {
    const model = reviewModel(review([]))
    expect(model.clientName).toBe(`Agent${SHY}Official`)
    expect(model.migrations[0]?.name).toBe(`add${SHY}notes`)
    expect(model.migrations[0]?.drops).toEqual([`table public.acc${SHY}ounts`])
  })

  it('carries the computed facts: target, tier, decision, rules, evidence, fingerprint, hash', () => {
    const model = reviewModel(review([]))
    expect(model).toMatchObject({
      targetPath: 'shop/platform/production',
      tier: 'prod',
      kind: 'migration.apply',
      class: 'high',
      decision: 'require',
      requirements: [{ kind: 'approval', count: 1 }],
      rules: [{ id: 'evidence.staging', result: 'pass' }],
      migrationPlan: { evidence: 'present', destructive: true, compatibility: 'destructive' },
      planHash: `sha256:ph1:${'ab'.repeat(32)}`,
    })
    expect(model.migrations[0]?.compatibility).toEqual({
      declared: 'additive',
      observed: 'destructive',
      disagree: true,
    })
    expect(model.migrations[0]?.rollback).toEqual({ available: false })
  })

  it('puts the statement facts on up.sql only, never on verify.sql', () => {
    const model = reviewModel(review([source('up.sql', UP), source('verify.sql', VERIFY)]))
    expect(model.sources.map((s) => s.file)).toEqual(['up.sql', 'verify.sql'])
    expect(model.sources[0]?.lines[0]?.statement?.kind).toBe('ALTER TABLE')
    expect(model.sources[1]?.lines.every((l) => l.statement === undefined)).toBe(true)
    expect(model.omitted).toBe(0)
  })

  it('counts the files it does not show', () => {
    const model = reviewModel(review([source('up.sql', UP)]))
    expect(model.runs).toBe(2)
    expect(model.omitted).toBe(1)
  })

  it('splits CR, LF and CRLF and counts characters a reader cannot see', () => {
    const text = `SELECT 1;\r\n-- ok${String.fromCodePoint(0x202e)}\rDROP TABLE x;`
    const model = reviewModel(review([source('up.sql', text)]))
    expect(model.sources[0]?.lines.map((l) => l.text)).toEqual([
      'SELECT 1;',
      `-- ok${String.fromCodePoint(0x202e)}`,
      'DROP TABLE x;',
    ])
    expect(model.sources[0]?.marked).toBe(1)
  })

  it('has no migration facts for a plan that is not a migration', () => {
    const model = reviewModel(
      review([], { kind: 'access.role_binding.create', change: { content: {}, analysis: {} } }),
    )
    expect(model.migrationPlan).toBeUndefined()
    expect(model.migrations).toEqual([])
    expect(model.runs).toBe(0)
  })
})
