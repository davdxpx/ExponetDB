import { fixedClock, type JsonObject } from '@exponetdb/kernel'
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
  procedural: false,
  proceduralReasons: [],
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
  kind = 'migration.apply',
) {
  return engine.evaluate({
    request: {
      kind,
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
    // A verification run again by an agent too (Wave 7): verify.sql reads production data.
    const person = { kind: 'human' as const, identityId: 'idn_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z' }
    const verify = (tier: 'prod' | 'nonprod', client: 'mcp' | 'cli') =>
      decide(tier, {}, { ...person, client }, undefined, 'migration.verify')
    const byAgent = await verify('prod', 'mcp')
    expect(byAgent.decision).toBe('require')
    expect(byAgent.rules.find((r) => r.id === 'migration.agent-production')).toMatchObject({
      result: 'fail',
    })
    expect((await verify('prod', 'cli')).decision).toBe('allow')
    expect((await verify('nonprod', 'mcp')).decision).toBe('allow')
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

  it('runs an explicit rollback on production only after an approval and a re-authentication; a lossy one also needs a backup', async () => {
    const human = undefined
    const nonprod = await decide(
      'nonprod',
      { evidence: 'not_required', lineage: 'not_required' },
      human,
      undefined,
      'migration.rollback',
    )
    expect(nonprod.decision).toBe('allow')
    const prod = await decide(
      'prod',
      { evidence: 'not_required', lineage: 'not_required' },
      human,
      undefined,
      'migration.rollback',
    )
    expect(prod.decision).toBe('require')
    expect(prod.requirements).toContainEqual({ kind: 'reauth', withinSeconds: 300 })
    const lossy = await decide(
      'prod',
      { compatibility: 'destructive', evidence: 'not_required', lineage: 'not_required' },
      human,
      undefined,
      'migration.rollback',
    )
    expect(lossy.requirements).toContainEqual({
      kind: 'backup',
      newerThan: 'PT24H',
      verified: true,
    })
    // down.sql passes the same lint gate as up.sql.
    expect(
      (
        await decide(
          'nonprod',
          { blockingFindings: 1, evidence: 'not_required', lineage: 'not_required' },
          human,
          undefined,
          'migration.rollback',
        )
      ).decision,
    ).toBe('deny')
  })

  it('adopts a target ledger as the truth (ledger.reconcile, TC-007) on production only after an approval and a re-authentication', async () => {
    const rule = (d: Awaited<ReturnType<typeof decide>>, id: string) =>
      d.rules.find((r) => r.id === id)
    // The plan carries no migration facts: the rule reads only the tier the planner resolved.
    const nonprod = await decide('nonprod', null, undefined, undefined, 'ledger.reconcile')
    expect(nonprod.decision).toBe('allow')
    expect(rule(nonprod, 'migration.ledger-reconcile-production')?.result).toBe('not_applicable')
    const prod = await decide('prod', null, undefined, undefined, 'ledger.reconcile')
    expect(prod.decision).toBe('require')
    expect(rule(prod, 'migration.ledger-reconcile-production')).toMatchObject({ result: 'fail' })
    expect(prod.requirements).toContainEqual({ kind: 'reauth', withinSeconds: 300 })
    expect(prod.requirements).toContainEqual({
      kind: 'approval',
      count: 1,
      permission: 'plans.approve',
    })
    // An unknown tier requires what production requires, and no break-glass grant overrides it.
    const unknown = await decide(undefined, null, undefined, undefined, 'ledger.reconcile')
    expect(unknown.decision).toBe('require')
    const granted = await decide(
      'prod',
      null,
      undefined,
      {
        grantId: 'brk_01M4A000000000000000000001',
        rules: ['migration.ledger-reconcile-production'],
      },
      'ledger.reconcile',
    )
    expect(granted.decision).toBe('require')
    // It is not part of the decision of any migration kind.
    expect(rule(await decide('prod', {}), 'migration.ledger-reconcile-production')).toBeUndefined()
  })

  it('re-verifies freely, unless verify.sql calls consumer code', async () => {
    const facts = { evidence: 'not_required', lineage: 'not_required' } as const
    expect((await decide('prod', facts, undefined, undefined, 'migration.verify')).decision).toBe(
      'allow',
    )
    expect(
      (
        await decide(
          'prod',
          { ...facts, consumerCode: 2 },
          undefined,
          undefined,
          'migration.verify',
        )
      ).decision,
    ).toBe('require')
  })

  it('resumes a non-transactional bundle on production only after an approval and a re-authentication; a blocking readback denies', async () => {
    const facts = {
      nontransactional: true,
      evidence: 'not_required',
      lineage: 'not_required',
    } as const
    const prod = await decide('prod', facts, undefined, undefined, 'migration.resume')
    expect(prod.decision).toBe('require')
    expect(prod.requirements).toContainEqual({ kind: 'reauth', withinSeconds: 300 })
    expect(
      (await decide('nonprod', facts, undefined, undefined, 'migration.resume')).decision,
    ).toBe('allow')
    expect(
      (
        await decide(
          'nonprod',
          { ...facts, blockingFindings: 1 },
          undefined,
          undefined,
          'migration.resume',
        )
      ).decision,
    ).toBe('deny')
  })
})

describe('migration.import-execution-role', () => {
  const replay = (content: JsonObject) =>
    engine.evaluate({
      request: {
        kind: 'migration.import.replay',
        principal: { kind: 'human', identityId: 'idn_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z', client: 'web' },
        subject: { tier: 'nonprod' },
        content,
      },
      settings: [],
    })
  const rule = async (content: JsonObject) =>
    (await replay(content)).rules.find((r) => r.id === 'migration.import-execution-role')

  it('allows a replay whose execution role is usable, and one excused by a declared exception', async () => {
    const usable = await replay({ executionRoleCheck: { role: 'acme_owner', problem: null } })
    expect(usable.decision).toBe('allow')
    expect(
      (await rule({ executionRoleCheck: { role: 'acme_owner', problem: 'declared_exception' } }))
        ?.result,
    ).toBe('pass')
  })

  it('denies any other problem, and a plan without the check, never overridable', async () => {
    for (const problem of [
      'privileged_attribute',
      'can_login',
      'reaches_protected_role',
      'missing',
    ]) {
      const d = await replay({ executionRoleCheck: { role: 'acme_owner', problem } })
      expect(d.decision, problem).toBe('deny')
      expect(d.rules.find((r) => r.id === 'migration.import-execution-role')).toMatchObject({
        result: 'fail',
        overridableByBreakGlass: false,
        facts: { role: 'acme_owner', problem },
      })
    }
    expect((await replay({})).decision).toBe('deny')
    expect((await rule({ executionRoleCheck: { role: 7, problem: null } }))?.result).toBe('unknown')
  })
})

describe('execution-role exceptions and parity (ADR-0034)', () => {
  it('warns in every plan that uses a declared exception, never blocking', async () => {
    for (const tier of ['nonprod', 'prod'] as const) {
      const d = await decide(tier, { executionRoleExceptions: 1, executionRoleParity: 'match' })
      expect(d.decision, tier).toBe('allow')
      expect(d.rules.find((r) => r.id === 'migration.execution-role-exception')).toMatchObject({
        result: 'fail',
        severity: 'warn',
      })
    }
    const none = await decide('nonprod', { executionRoleExceptions: 0 })
    expect(none.rules.find((r) => r.id === 'migration.execution-role-exception')?.result).toBe(
      'not_applicable',
    )
  })

  it('warns on production when the evidence ran under other execution roles or that is not known', async () => {
    for (const parity of ['mismatch', 'unknown'] as const) {
      const d = await decide('prod', { executionRoleParity: parity })
      expect(d.decision, parity).toBe('allow')
      expect(d.rules.find((r) => r.id === 'migration.execution-role-parity')).toMatchObject({
        result: 'fail',
        severity: 'warn',
        facts: { parity },
      })
    }
    expect(
      (await decide('prod', { executionRoleParity: 'match' })).rules.find(
        (r) => r.id === 'migration.execution-role-parity',
      )?.result,
    ).toBe('pass')
    expect(
      (await decide('nonprod', {})).rules.find((r) => r.id === 'migration.execution-role-parity')
        ?.result,
    ).toBe('not_applicable')
  })
})

describe('procedural SQL (OD-55 (c) and (d))', () => {
  const person = { kind: 'human' as const, identityId: 'idn_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z' }
  const agents: PolicyRequest['principal'][] = [
    { ...person, client: 'mcp' },
    { ...person, client: 'rest' },
    { kind: 'service', identityId: null, client: 'ci' },
  ]
  const rule = (d: Awaited<ReturnType<typeof decide>>, id: string) =>
    d.rules.find((r) => r.id === id)

  it('requires a person for an agent plan with procedural SQL on every tier, nonprod included', async () => {
    for (const tier of ['nonprod', 'prod'] as const) {
      for (const principal of agents) {
        for (const kind of ['migration.apply', 'migration.rollback', 'migration.resume']) {
          const d = await decide(
            tier,
            {
              procedural: true,
              proceduralReasons: ['do_block', 'dynamic_sql'],
              ...(kind === 'migration.resume' ? { nontransactional: false } : {}),
            },
            principal,
            undefined,
            kind,
          )
          const label = `${tier} ${principal.client} ${kind}`
          expect(d.decision, label).toBe('require')
          expect(d.requirements, label).toContainEqual({
            kind: 'approval',
            count: 1,
            permission: 'plans.approve',
          })
          expect(rule(d, 'migration.agent-procedural'), label).toMatchObject({
            result: 'fail',
            severity: 'require',
            overridableByBreakGlass: false,
            facts: { reasons: ['do_block', 'dynamic_sql'] },
          })
        }
      }
    }
  })

  it('lets an agent plan without procedural SQL through on nonprod, and a person plan with it', async () => {
    const agent = await decide('nonprod', { procedural: false }, agents[0])
    expect(agent.decision).toBe('allow')
    expect(rule(agent, 'migration.agent-procedural')?.result).toBe('pass')
    for (const client of ['web', 'cli'] as const) {
      const d = await decide('nonprod', { procedural: true }, { ...person, client })
      expect(d.decision, client).toBe('allow')
      expect(rule(d, 'migration.agent-procedural')?.result, client).toBe('not_applicable')
    }
  })

  it('counts a plan without the classification, or a malformed one, as procedural (fail closed)', async () => {
    for (const procedural of [undefined, 'yes', null]) {
      const d = await engine.evaluate({
        request: {
          kind: 'migration.apply',
          principal: agents[0] as PolicyRequest['principal'],
          subject: { tier: 'nonprod' },
          content: {
            facts: {
              ...CLEAN,
              evidence: 'not_required',
              lineage: 'not_required',
              procedural: procedural as never,
            } as unknown as JsonObject,
          },
        },
        settings: [],
      })
      expect(d.decision, String(procedural)).toBe('require')
      expect(rule(d, 'migration.agent-procedural')).toMatchObject({
        result: 'fail',
        facts: { reasons: ['unclassified'] },
      })
    }
    // A legacy replay carries no classification: an agent's replay always needs a person.
    const replay = await engine.evaluate({
      request: {
        kind: 'migration.import.replay',
        principal: agents[0] as PolicyRequest['principal'],
        subject: { tier: 'nonprod' },
        content: { executionRoleCheck: { role: 'app_owner', problem: null } },
      },
      settings: [],
    })
    expect(rule(replay, 'migration.agent-procedural')?.result).toBe('fail')
    expect(replay.decision).toBe('require')
  })

  it('denies procedural SQL in a non-transactional bundle for every principal, never overridable', async () => {
    for (const principal of [{ ...person, client: 'cli' as const }, agents[0]]) {
      for (const kind of ['migration.apply', 'migration.resume']) {
        const d = await decide(
          'nonprod',
          { nontransactional: true, procedural: true, proceduralReasons: ['do_block'] },
          principal,
          {
            grantId: 'brk_01M4A000000000000000000001',
            rules: ['migration.procedural-nontransactional'],
          },
          kind,
        )
        expect(d.decision, kind).toBe('deny')
        expect(rule(d, 'migration.procedural-nontransactional')).toMatchObject({
          result: 'fail',
          severity: 'deny',
        })
        expect(d.overriddenRules).toEqual([])
      }
    }
    // Without the classification it counts as procedural; without procedural SQL it passes.
    expect(
      (await decide('nonprod', { nontransactional: true, procedural: undefined as never }))
        .decision,
    ).toBe('deny')
    const plain = await decide('nonprod', { nontransactional: true, procedural: false })
    expect(plain.decision).toBe('allow')
    expect(rule(plain, 'migration.procedural-nontransactional')?.result).toBe('pass')
    expect(
      rule(await decide('nonprod', { procedural: true }), 'migration.procedural-nontransactional')
        ?.result,
    ).toBe('not_applicable')
  })
})
