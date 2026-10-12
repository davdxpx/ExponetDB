import { fixedClock } from '@exponetdb/kernel'
import { describe, expect, it } from 'vitest'
import {
  MIGRATION_RULES,
  type MigrationFacts,
  PolicyEngine,
  type PolicyRequest,
  RuleRegistry,
} from '../src/index.ts'

/** The Wave 6 migration rules (policy-engine.md §4 "Migrations", C-13 to C-16). */
const engine = new PolicyEngine({
  registry: new RuleRegistry(MIGRATION_RULES),
  providers: [],
  codeVersion: '0.1.0+test',
  clock: fixedClock(Date.UTC(2026, 9, 12)),
})

const CLEAN: MigrationFacts = {
  compatibility: 'additive',
  lockSeverity: 'low',
  nontransactional: false,
  blockingFindings: 0,
  consumerCode: 0,
  requirementsUnmet: [],
  evidence: 'present',
  lineage: 'match',
  dependenciesVerified: true,
  legacyProject: false,
}

function decide(
  tier: 'prod' | 'nonprod' | undefined,
  facts: Partial<MigrationFacts> | null,
  principal: PolicyRequest['principal'] = {
    kind: 'human',
    identityId: 'idn_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z',
    client: 'cli',
  },
  breakGlass?: PolicyRequest['breakGlass'],
) {
  return engine.evaluate({
    request: {
      kind: 'migration.apply',
      principal,
      subject: tier === undefined ? {} : { tier },
      content: facts === null ? {} : { facts: { ...CLEAN, ...facts } },
      ...(breakGlass === undefined ? {} : { breakGlass }),
    },
    settings: [],
  })
}

describe('migration rules', () => {
  it('allows a clean additive plan on both tiers', async () => {
    expect(
      (await decide('nonprod', { evidence: 'not_required', lineage: 'not_required' })).decision,
    ).toBe('allow')
    expect((await decide('prod', {})).decision).toBe('allow')
  })

  it('denies without readable facts, blocking findings or unmet requirements, whatever the tier', async () => {
    expect((await decide('nonprod', null)).decision).toBe('deny')
    expect((await decide('nonprod', { blockingFindings: 2 })).decision).toBe('deny')
    for (const r of ['postgres', 'extensions', 'execution_role']) {
      expect((await decide('nonprod', { requirementsUnmet: [r] })).decision, r).toBe('deny')
    }
  })

  it('denies production without evidence, also when the evidence target cannot be read; no override setting exists', async () => {
    for (const evidence of ['missing', 'unverified', 'unreachable'] as const) {
      const d = await decide('prod', { evidence })
      expect(d.decision, evidence).toBe('deny')
      expect(d.rules.find((r) => r.id === 'migration.staging-evidence')?.result).not.toBe('pass')
    }
    // Only a break-glass grant naming the rule overrides it (human-only, checked by the auth layer).
    const glass = await decide('prod', { evidence: 'missing' }, undefined, {
      grantId: 'brk_01M4A000000000000000000001',
      rules: ['migration.staging-evidence'],
    })
    expect(glass.decision).not.toBe('deny')
    expect(glass.overriddenRules).toEqual(['migration.staging-evidence'])
    // The lint rule is not overridable.
    const lint = await decide('prod', { blockingFindings: 1 }, undefined, {
      grantId: 'brk_01M4A000000000000000000001',
      rules: ['migration.lint-errors'],
    })
    expect(lint.decision).toBe('deny')
  })

  it('requires approvals on production for non-additive, high-lock, agent and lineage cases', async () => {
    for (const facts of [
      { compatibility: 'potentially_breaking' },
      { lockSeverity: 'high' },
      { lineage: 'mismatch' as const },
      { lineage: 'unknown' as const },
    ]) {
      const d = await decide('prod', facts)
      expect(d.decision, JSON.stringify(facts)).toBe('require')
      expect(d.requirements).toContainEqual({
        kind: 'approval',
        count: 1,
        permission: 'plans.approve',
      })
    }
    const agent = await decide('prod', {}, { kind: 'service', identityId: null, client: 'mcp' })
    expect(agent.decision).toBe('require')
    // Imported legacy history: a lineage difference is a warning only (OD-14 (a)).
    expect((await decide('prod', { lineage: 'mismatch', legacyProject: true })).decision).toBe(
      'allow',
    )
  })

  it('requires a backup for destructive production changes (unmet before Wave 9) and a re-authentication for non-transactional ones', async () => {
    const destructive = await decide('prod', { compatibility: 'destructive' })
    expect(destructive.requirements).toContainEqual({
      kind: 'backup',
      newerThan: 'PT24H',
      verified: true,
    })
    const nontx = await decide('prod', { nontransactional: true })
    expect(nontx.requirements).toContainEqual({ kind: 'reauth', withinSeconds: 300 })
    // Nonprod: neither.
    expect(
      (
        await decide('nonprod', {
          compatibility: 'destructive',
          nontransactional: true,
          evidence: 'not_required',
        })
      ).decision,
    ).toBe('allow')
  })

  it('requires an approval for consumer code in verify.sql on every tier', async () => {
    expect((await decide('nonprod', { consumerCode: 1, evidence: 'not_required' })).decision).toBe(
      'require',
    )
    expect((await decide('prod', { consumerCode: 1 })).decision).toBe('require')
  })

  it('treats an unknown tier like production', async () => {
    expect((await decide(undefined, { evidence: 'missing' })).decision).toBe('deny')
  })
})
