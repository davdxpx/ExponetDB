import type { ApprovalReview, PlanView } from '@exponetdb/sdk/operations'
import { describe, expect, it } from 'vitest'
import {
  analysisOf,
  classificationsOf,
  confirmFactsOf,
  evidenceOf,
  filesOf,
  isOperationId,
  isPlanId,
  migrationAnalysisOf,
  planPath,
  requirementsOf,
  rulesOf,
} from '../../src/features/plans/plan-model.ts'
import { HASH, hostileItem, hostilePlan, MIGRATION, PLAN, SHY } from './support.tsx'

const plan = (over: Partial<PlanView> = {}): PlanView => ({ ...hostilePlan(), ...over }) as PlanView

describe('plan ids and paths', () => {
  it('accepts a plan id and builds its review path only from one', () => {
    expect(isPlanId(PLAN)).toBe(true)
    expect(planPath(PLAN)).toBe(`/changes/plans/${PLAN}`)
    expect(isOperationId('op_01M4S9000000000000000000AA')).toBe(true)
  })

  it('refuses anything else, so a server value never becomes a path', () => {
    for (const bad of [
      '',
      'pln_',
      'pln_x',
      `${PLAN}/../../admin`,
      `/${PLAN}`,
      `${PLAN}?x=1`,
      `${PLAN}#x`,
      'pln_01m4s9000000000000000000aa',
      'pln_81M4S9000000000000000000AA',
      'pln_01M4S9000000000000000000AU',
      `${PLAN}\n`,
      `pln_01M4S9000000000000000000A${String.fromCodePoint(0x0391)}`,
      '//evil.example/x',
      'javascript:alert(1)',
      null,
      42,
    ]) {
      expect(isPlanId(bad), String(bad)).toBe(false)
      expect(planPath(bad), String(bad)).toBeUndefined()
    }
    expect(isOperationId(`op_01M4S9000000000000000000AA${String.fromCodePoint(0x202e)}`)).toBe(
      false,
    )
  })
})

describe('the confirmation facts of a plan', () => {
  it('binds the hash, the tier (failing closed), the class and the path to type', () => {
    expect(confirmFactsOf(plan())).toEqual({
      planHash: HASH,
      tier: 'prod',
      planClass: 'high',
      targetPath: 'shop/platform/production',
    })
    const noTier = plan({ subject: { ...plan().subject, tier: null } })
    expect(confirmFactsOf(noTier).tier).toBe('prod')
    const nonprod = plan({ subject: { ...plan().subject, tier: 'nonprod' } })
    expect(confirmFactsOf(nonprod).tier).toBe('nonprod')
  })

  it('needs the typed path for a class it does not know and the typed effect for critical', () => {
    expect(confirmFactsOf(plan({ class: 'read' })).planClass).toBe('high')
    expect(confirmFactsOf(plan({ class: 'standard' })).planClass).toBe('standard')
    expect(confirmFactsOf(plan({ class: 'critical' }))).toMatchObject({
      planClass: 'critical',
      effect: 'migration.apply shop/platform/production',
    })
  })

  it('types the cluster, the node or the plan id when the plan has no target', () => {
    const subject = { targetId: null, targetPath: null, clusterId: null, nodeId: null, tier: null }
    expect(
      confirmFactsOf(plan({ subject: { ...subject, clusterId: 'cls_01M4S9000000000000000000AF' } }))
        .targetPath,
    ).toBe('cls_01M4S9000000000000000000AF')
    expect(
      confirmFactsOf(plan({ subject: { ...subject, nodeId: 'nod_01M4S9000000000000000000AF' } }))
        .targetPath,
    ).toBe('nod_01M4S9000000000000000000AF')
    expect(confirmFactsOf(plan({ subject })).targetPath).toBe(PLAN)
  })
})

describe('the analysis of a migration plan', () => {
  it('keeps a lock the analysis did not derive apart from one it does not know', () => {
    const migration = migrationAnalysisOf(
      { migrationId: MIGRATION, name: 'x', checksum: 'sha256:c1:x' },
      {
        statements: [
          { index: 0, line: 1, kind: 'SELECT', lock: null, coverage: 'derived' },
          { index: 1, line: 2, kind: 'ALTER TABLE' },
          { index: 2, line: 3, kind: 'ALTER TABLE', lock: { mode: 'SHARE', severity: 'low' } },
        ],
      },
    )
    expect(migration.statements?.map((s) => s.lock)).toEqual([
      'none',
      null,
      { mode: 'SHARE', severity: 'low' },
    ])
    // A field the server did not send stays not known.
    expect(migration.statements?.[1]?.rewrite).toBeUndefined()
    expect(migration.statements?.[1]?.transactional).toBeNull()
    expect(migration.compatibility).toBeNull()
    expect(migration.drops).toBeNull()
    expect(migration.rollback).toBeNull()
  })

  it('says "not known" for every fact of a migration the analysis does not cover', () => {
    expect(
      migrationAnalysisOf({ migrationId: MIGRATION, name: `n${SHY}`, checksum: null }, undefined),
    ).toEqual({
      migrationId: MIGRATION,
      name: `n${SHY}`,
      compatibility: null,
      lockSeverity: null,
      statements: null,
      drops: null,
      rewrites: null,
      rollback: null,
      checksum: null,
    })
  })

  it('keeps foreign names raw for the untrusted-text renderer', () => {
    const analysis = analysisOf(plan())
    expect(analysis?.migrations?.[0]?.name).toBe(`add${SHY}notes`)
    expect(analysis?.migrations?.[0]?.drops?.[0]).toBe(`table public.acc${SHY}ounts`)
    expect(analysis?.migrations?.[0]?.compatibility).toEqual({
      declared: 'additive',
      observed: 'destructive',
      disagree: true,
    })
  })

  it('names the statement classes only when every fact behind them is known', () => {
    const analysis = analysisOf(plan())
    expect(analysis?.classifications).toEqual(['destructive', 'rewrite'])
    expect(classificationsOf(null, [])).toBeNull()
    expect(
      classificationsOf(
        { compatibility: null, lockSeverity: null, destructive: null, nontransactional: false },
        [],
      ),
    ).toBeNull()
    const unknownRewrite = migrationAnalysisOf(
      { migrationId: MIGRATION },
      { statements: [{ index: 0, line: 1, kind: 'UPDATE' }], rewriteRisk: [] },
    )
    expect(
      classificationsOf(
        { compatibility: null, lockSeverity: null, destructive: false, nontransactional: false },
        [unknownRewrite],
      ),
    ).toBeNull()
    const rewrite = migrationAnalysisOf(
      { migrationId: MIGRATION },
      { statements: [{ index: 0, line: 1, kind: 'ALTER', rewrite: 'table' }], rewriteRisk: [] },
    )
    expect(
      classificationsOf(
        { compatibility: null, lockSeverity: null, destructive: false, nontransactional: true },
        [rewrite],
      ),
    ).toEqual(['rewrite', 'non_transactional'])
  })

  it('has no analysis, evidence or policy rules for a plan that is not a migration', () => {
    const access = plan({
      kind: 'access.role_binding.create' as PlanView['kind'],
      policyRules: undefined,
    })
    expect(analysisOf(access)).toBeUndefined()
    expect(evidenceOf(access)).toBeUndefined()
    expect(rulesOf(access)).toBeNull()
  })

  it('reads the evidence, the bound fingerprint and the requirements', () => {
    expect(evidenceOf(plan())).toEqual({
      evidence: 'present',
      items: [],
      breakGlass: null,
      schemaFingerprint: `sha256:fp1:${'01'.repeat(32)}`,
    })
    expect(requirementsOf(plan())).toEqual([
      {
        kind: 'approval',
        count: 1,
        permission: 'plans.approve',
        withinSeconds: null,
        newerThan: null,
        windowId: null,
        rules: null,
      },
    ])
  })
})

describe('the files the plan runs', () => {
  it('puts the statement facts on up.sql only and keeps the text as received', () => {
    const review = hostileItem().review as ApprovalReview
    const files = filesOf(review)
    expect(files.files.map((f) => f.file)).toEqual(['up.sql', 'verify.sql'])
    expect(files.files[0]?.lines.filter((l) => l.statement !== undefined)).toHaveLength(2)
    expect(files.files[1]?.lines.every((l) => l.statement === undefined)).toBe(true)
    expect(files.files[0]?.text).toBe(review.sources[0]?.text)
    expect(files.omitted).toBe(0)
    expect(files.runs).toBe(2)
  })

  it('counts the files the server did not send', () => {
    const review = hostileItem().review as ApprovalReview
    const files = filesOf({ ...review, sources: review.sources.slice(0, 1) })
    expect(files.omitted).toBe(1)
  })
})
