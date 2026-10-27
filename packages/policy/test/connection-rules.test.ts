import { isActionId } from '@exponetdb/contracts'
import { fixedClock } from '@exponetdb/kernel'
import { describe, expect, it } from 'vitest'
import {
  CONNECTION_KINDS,
  CONNECTION_RULES,
  PolicyEngine,
  type PolicyRequest,
  type Principal,
  RuleRegistry,
} from '../src/index.ts'

/** The connection rules of Wave 9 Part B (policy-engine.md §4 "Connections"; performance.md §5). */
const engine = new PolicyEngine({
  registry: new RuleRegistry(CONNECTION_RULES),
  providers: [],
  codeVersion: '0.1.0+test',
  clock: fixedClock(Date.UTC(2026, 9, 27)),
})

const PERSON: Principal = {
  kind: 'human',
  identityId: 'idn_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z',
  client: 'web',
}
const AGENT: Principal = { ...PERSON, client: 'rest', kind: 'service' }

const request = (
  kind: string,
  session: unknown,
  tier: 'prod' | 'nonprod' | 'unknown' = 'nonprod',
  principal: Principal = PERSON,
): PolicyRequest => ({
  kind,
  principal,
  subject: tier === 'unknown' ? {} : { tier },
  content: session === undefined ? {} : ({ session } as never),
})

const session = (protectedReason: string | null, found = true) => ({
  found,
  here: true,
  backendType: 'client backend',
  role: 'app',
  applicationName: 'app',
  state: 'active',
  protected: protectedReason,
})

const decide = (r: PolicyRequest) => engine.evaluate({ request: r, settings: [] })

describe('connection rules', () => {
  it('apply to the two operation kinds of the contracts', () => {
    for (const kind of CONNECTION_KINDS) expect(isActionId(kind), kind).toBe(true)
  })

  it('allow a client session that is not protected', async () => {
    for (const kind of CONNECTION_KINDS) {
      const d = await decide(request(kind, session(null)))
      expect(d.decision, kind).toBe('allow')
    }
  })

  it('deny replication, background and backup sessions (overridable by break-glass only)', async () => {
    for (const reason of ['not_client_backend', 'backup_session']) {
      const d = await decide(request('connections.terminate', session(reason)))
      expect(d.decision, reason).toBe('deny')
      const rule = d.rules.find((r) => r.id === 'connections.replication-protect')
      expect(rule).toMatchObject({ result: 'fail', overridableByBreakGlass: true })
    }
  })

  it('deny superuser and ExponetDB sessions, not overridable', async () => {
    for (const reason of ['superuser_session', 'exponetdb_session']) {
      const d = await decide(request('connections.cancel', session(reason)))
      expect(d.decision, reason).toBe('deny')
      expect(d.rules.find((r) => r.id === 'connections.no-superuser-terminate')).toMatchObject({
        result: 'fail',
        overridableByBreakGlass: false,
      })
    }
  })

  it('fail closed without session facts', async () => {
    const d = await decide(request('connections.cancel', undefined))
    expect(d.decision).toBe('deny')
  })

  it('ask a person to approve an agent planning a production termination', async () => {
    const agentProd = await decide(request('connections.terminate', session(null), 'prod', AGENT))
    expect(agentProd.decision).toBe('require')
    expect(agentProd.requirements).toEqual([
      { kind: 'approval', count: 1, permission: 'plans.approve' },
    ])
    expect((await decide(request('connections.terminate', session(null), 'prod'))).decision).toBe(
      'allow',
    )
    expect(
      (await decide(request('connections.terminate', session(null), 'nonprod', AGENT))).decision,
    ).toBe('allow')
    // An unknown tier requires what production requires.
    expect(
      (await decide(request('connections.terminate', session(null), 'unknown', AGENT))).decision,
    ).toBe('require')
    // A cancel is low: no approval rule.
    expect(
      (await decide(request('connections.cancel', session(null), 'prod', AGENT))).decision,
    ).toBe('allow')
  })
})
