import { fixedClock, type JsonValue } from '@exponetdb/kernel'
import { describe, expect, it } from 'vitest'
import { BACKUP_RULES, PolicyEngine, type PolicyRequest, RuleRegistry } from '../src/index.ts'

/** The backup and restore rules of Wave 9 Part B (policy-engine.md §4, "Backups and restore"). */
const engine = new PolicyEngine({
  registry: new RuleRegistry(BACKUP_RULES),
  providers: [],
  codeVersion: '0.1.0+test',
  clock: fixedClock(Date.UTC(2026, 9, 26)),
})

type Principal = PolicyRequest['principal']
const PERSON: Principal = {
  kind: 'human',
  identityId: 'idn_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z',
  client: 'web',
}
/** An agent (OD-13 (a)): a person's grant used through MCP. */
const AGENT: Principal = {
  kind: 'human',
  identityId: 'idn_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z',
  client: 'mcp',
}

const decide = (
  kind: string,
  options: { tier?: 'prod' | 'nonprod'; principal?: Principal; content?: JsonValue } = {},
) =>
  engine.evaluate({
    request: {
      kind,
      principal: options.principal ?? PERSON,
      subject: options.tier === undefined ? {} : { tier: options.tier },
      ...(options.content === undefined ? {} : { content: options.content }),
    },
    settings: [],
  })

const drill = (over: Record<string, JsonValue> = {}): JsonValue => ({
  purpose: 'drill',
  source: { verification: 'passed', walContinuous: true, systemIdentifier: '7400000000000000101' },
  destination: { kind: 'scratch', nodeId: 'nod_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z' },
  ...over,
})

describe('backup.change-prod-approval', () => {
  it('lets a nonprod repository be adopted without approval', async () => {
    expect((await decide('backup.repository.adopt', { tier: 'nonprod' })).decision).toBe('allow')
  })

  it('requires an approval and re-authentication on production and on an unknown tier', async () => {
    for (const tier of ['prod', undefined] as const) {
      const d = await decide('backup.policy.set', tier === undefined ? {} : { tier })
      expect(d.decision, String(tier)).toBe('require')
      expect(d.requirements).toEqual(
        expect.arrayContaining([
          { kind: 'approval', count: 1, permission: 'plans.approve' },
          { kind: 'reauth', withinSeconds: 300 },
        ]),
      )
    }
  })
})

describe('restore.human-only', () => {
  it("denies an agent's drill, discard and recovery on every tier", async () => {
    for (const kind of ['restore.drill', 'restore.discard', 'restore.execute']) {
      const d = await decide(kind, { tier: 'nonprod', principal: AGENT, content: drill() })
      expect(d.decision, kind).toBe('deny')
    }
  })

  it("allows a person's nonprod drill into scratch from a verified source", async () => {
    expect((await decide('restore.drill', { tier: 'nonprod', content: drill() })).decision).toBe(
      'allow',
    )
  })
})

describe('restore.source-verified and restore.target-identity', () => {
  it('denies a source without a passed verification', async () => {
    const d = await decide('restore.drill', {
      tier: 'nonprod',
      content: drill({
        source: { verification: 'pending', walContinuous: true, systemIdentifier: '1' },
      }),
    })
    expect(d.decision).toBe('deny')
  })

  it('denies a WAL range that is not shown continuous', async () => {
    const d = await decide('restore.drill', {
      tier: 'nonprod',
      content: drill({
        source: { verification: 'passed', walContinuous: false, systemIdentifier: '1' },
      }),
    })
    expect(d.decision).toBe('deny')
  })

  it('denies a drill whose destination is not scratch, and a plan that binds no destination', async () => {
    const elsewhere = await decide('restore.drill', {
      tier: 'nonprod',
      content: drill({
        destination: { kind: 'new_cluster', nodeId: 'nod_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z' },
      }),
    })
    expect(elsewhere.decision).toBe('deny')
    const unbound = await decide('restore.drill', {
      tier: 'nonprod',
      content: { purpose: 'drill' },
    })
    expect(unbound.decision).not.toBe('allow')
  })
})

describe('restore.recovery-approval and restore.clone-masking', () => {
  it('a recovery into a new cluster always needs an approval, also on nonprod', async () => {
    const d = await decide('restore.execute', {
      tier: 'nonprod',
      content: drill({
        purpose: 'recovery',
        destination: { kind: 'new_cluster', nodeId: 'nod_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z' },
      }),
    })
    expect(d.decision).toBe('require')
    expect(d.requirements.some((r) => r.kind === 'approval')).toBe(true)
  })

  it('a clone is refused', async () => {
    const d = await decide('restore.execute', {
      tier: 'nonprod',
      content: drill({ purpose: 'clone' }),
    })
    expect(d.decision).toBe('deny')
  })
})

describe('backup.repository-runs-allowed and backup.run-agent-prod-approval', () => {
  const run = (ownership: string, kind: string): JsonValue => ({ kind, repository: { ownership } })

  it('an adopted repository that allows runs takes incremental backups only', async () => {
    expect(
      (await decide('backup.run', { tier: 'nonprod', content: run('adopted_runs', 'incremental') }))
        .decision,
    ).toBe('allow')
    for (const kind of ['full', 'differential']) {
      expect(
        (await decide('backup.run', { tier: 'nonprod', content: run('adopted_runs', kind) }))
          .decision,
        kind,
      ).toBe('deny')
    }
    expect(
      (
        await decide('backup.run', {
          tier: 'nonprod',
          content: run('adopted_observed', 'incremental'),
        })
      ).decision,
    ).toBe('deny')
  })

  it("an agent's production run waits for a person; a person's does not", async () => {
    const content = run('adopted_runs', 'incremental')
    expect((await decide('backup.run', { tier: 'prod', principal: AGENT, content })).decision).toBe(
      'require',
    )
    expect((await decide('backup.run', { tier: 'prod', content })).decision).toBe('allow')
  })
})
