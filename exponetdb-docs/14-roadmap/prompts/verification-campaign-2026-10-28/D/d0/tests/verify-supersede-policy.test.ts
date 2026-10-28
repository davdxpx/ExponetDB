import { fixedClock } from '@exponetdb/kernel'
import { describe, expect, it } from 'vitest'
import { MIGRATION_RULES, PolicyEngine, RuleRegistry } from '../src/index.ts'

/**
 * D0 exploratory test: the policy decision for a `migration.verify` plan that names an operation to close
 * (content.supersedes, TC-005) on a PRODUCTION target, initiated by a person (cli / web), and for the same
 * plan initiated through MCP. The decision does not read `supersedes`: no approval, no re-authentication.
 * Copy to packages/policy/test/ of a work copy.
 */
const engine = new PolicyEngine({
  registry: new RuleRegistry(MIGRATION_RULES),
  providers: [],
  codeVersion: '0.1.0+test',
  clock: fixedClock(Date.UTC(2026, 9, 28)),
})
const facts = {
  compatibility: 'additive', lockSeverity: 'none', nontransactional: false, blockingFindings: 0, consumerCode: 0,
  requirementsUnmet: [], evidence: 'not_required', lineage: 'not_required', dependenciesVerified: true, legacyProject: false, procedural: false, proceduralReasons: [],
}
const decide = (client: 'web' | 'cli' | 'mcp', kind = 'migration.verify', extra: Record<string, unknown> = {}) =>
  engine.evaluate({
    request: {
      kind,
      principal: { kind: 'human', identityId: 'idn_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z', client },
      subject: { tier: 'prod' },
      content: { facts: { ...facts, ...extra }, supersedes: 'op_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z' },
    },
    settings: [],
  })

describe('closing a production operation through a migration.verify plan (D0)', () => {
  it('a person gets allow without approval or re-authentication; MCP gets an approval', async () => {
    for (const client of ['web', 'cli'] as const) {
      const d = await decide(client)
      expect([client, d.decision, d.requirements]).toEqual([client, 'allow', []])
    }
    const mcp = await decide('mcp')
    expect(mcp.decision).toBe('require')
    expect(mcp.requirements).toEqual([{ kind: 'approval', count: 1, permission: 'plans.approve' }])
  })

  it('migration.resume (the other recovery plan, always non-transactional) on production: a person needs an approval and a re-authentication', async () => {
    const d = await decide('cli', 'migration.resume', { nontransactional: true })
    expect(d.decision).toBe('require')
    expect(d.requirements.map((r) => r.kind).sort()).toEqual(['approval', 'reauth'])
  })
})
