import { describe, expect, it } from 'vitest'
import {
  nextActionOf,
  operationRead,
  planRead,
  planView,
  verificationRetryable,
} from '../src/views.ts'

/**
 * The next action an operation read names (Wave 6, `OperationNextAction`):
 * derived from the state and the outcomes only, never "done" while the
 * server works, never a rollback for a failed verification.
 */
describe('nextActionOf', () => {
  it('names the action for every state and outcome that matters', () => {
    expect(nextActionOf('awaiting_approval', 'not_started', 'pending', null)).toBe('approve')
    for (const state of ['queued', 'running', 'verifying', 'needs_reconciliation'] as const) {
      expect(nextActionOf(state, 'not_started', 'pending', null)).toBe('wait')
    }
    expect(nextActionOf('needs_attention', 'unknown', 'pending', null)).toBe('inspect')
    expect(nextActionOf('succeeded', 'applied', 'passed', null)).toBe('none')
    expect(nextActionOf('canceled', 'not_started', 'not_applicable', null)).toBe('none')
    expect(nextActionOf('verification_failed', 'applied', 'failed', null)).toBe('forward_fix')
    expect(
      nextActionOf('verification_failed', 'partially_applied', 'partial', 'MIGRATION_INCOMPLETE'),
    ).toBe('resume')
    expect(nextActionOf('failed', 'not_applied', 'not_applicable', 'MIGRATION_SQL_FAILED')).toBe(
      'replan',
    )
    expect(nextActionOf('failed', 'partially_applied', 'partial', null)).toBe('resume')
    expect(nextActionOf('failed', 'unknown', 'pending', null)).toBe('inspect')
  })
})

/**
 * `retryable` (Wave 8 order §9): the one predicate the retry route uses, so a
 * button in the Web App and the call it makes cannot disagree about the
 * operation itself.
 */
describe('verificationRetryable', () => {
  const op = (over: Partial<Parameters<typeof verificationRetryable>[0]> = {}) => ({
    kind: 'migration.apply',
    state: 'needs_attention',
    applyOutcome: 'applied',
    verificationOutcome: 'error',
    ...over,
  })

  it('is true only for an applied change whose verification errored or never finished', () => {
    expect(verificationRetryable(op())).toBe(true)
    expect(verificationRetryable(op({ verificationOutcome: 'pending' }))).toBe(true)
    expect(verificationRetryable(op({ kind: 'migration.resume' }))).toBe(true)
    expect(verificationRetryable(op({ applyOutcome: 'partially_applied' }))).toBe(true)
  })

  it('is false for every other state, outcome and kind', () => {
    for (const state of [
      'queued',
      'running',
      'verifying',
      'succeeded',
      'failed',
      'verification_failed',
      'canceled',
    ]) {
      expect(verificationRetryable(op({ state })), state).toBe(false)
    }
    for (const applyOutcome of ['not_started', 'not_applied', 'unknown']) {
      expect(verificationRetryable(op({ applyOutcome })), applyOutcome).toBe(false)
    }
    for (const verificationOutcome of ['passed', 'failed', 'partial', 'not_applicable']) {
      expect(verificationRetryable(op({ verificationOutcome })), verificationOutcome).toBe(false)
    }
    for (const kind of ['node.inspect', 'postgres.reload', 'credential.rotate', 'access.change']) {
      expect(verificationRetryable(op({ kind })), kind).toBe(false)
    }
  })

  it('is not offered for an operation without a plan, which the route could not retry', () => {
    const view = { ...op(), planId: null } as never
    expect(operationRead(view).retryable).toBe(false)
    const planned = { ...op(), planId: 'pln_01HZZZZZZZZZZZZZZZZZZZZZZZ' } as never
    expect(operationRead(planned).retryable).toBe(true)
  })
})

describe('planRead', () => {
  it('adds the operation that applied the plan, or null when none did', () => {
    const view = { planId: 'pln_01HZZZZZZZZZZZZZZZZZZZZZZZ' } as never
    expect(planRead(view, undefined)).toMatchObject({ operationId: null })
    expect(planRead(view, 'op_01HZZZZZZZZZZZZZZZZZZZZZZZ')).toMatchObject({
      operationId: 'op_01HZZZZZZZZZZZZZZZZZZZZZZZ',
    })
    // A value that is not an operation id is not passed on.
    expect(planRead(view, 'not an id')).toMatchObject({ operationId: null })
  })
})

/**
 * The change a person must judge before applying a node plan (TC-001,
 * control-plane.md §9.3): the plan view carries it for the seven `postgres.*`
 * kinds, with the node's host values (file paths and directories) left out.
 */
describe('planView of the postgres.* node plans', () => {
  const NODE = 'nod_01M5XZ84V768SYCHZKRNGJFQP2'
  const CLUSTER = 'cls_01M5J4RDBP52B715X5HDFKDN5F'
  const SERVER = 'srv_01M4WGQ6PH0GNK3P2ABMG4SGQE'
  const mapping = {
    nodeId: NODE,
    serverId: SERVER,
    clusterId: CLUSTER,
    localName: '17/main',
    systemIdentifier: '7701448509665702082',
  }
  const basis = (capability: string) => ({ capability, jobId: 'job_1', digest: 'sha256:abc' })

  /** What each real planner stores (capability-plans.ts), with the host values the node reports. */
  const bodies: Record<string, { content: object; analysis: object }> = {
    'postgres.reload': {
      content: { ...mapping, change: { reload: true }, basis: basis('postgres.status@1') },
      analysis: {
        observed: {
          running: true,
          acceptingConnections: true,
          version: '17.11',
          dataDirectory: '/var/lib/postgresql/17/main',
        },
      },
    },
    'postgres.restart': {
      content: {
        ...mapping,
        change: {},
        basis: basis('postgres.restart.plan@2'),
        targetIds: ['tgt_01M5J5G1P2QETPENWYHDJBVR4N'],
      },
      analysis: {
        observed: {
          shutdownMode: 'fast',
          pendingRestart: ['shared_buffers'],
          connections: [{ role: 'staging_app', count: 9 }],
          activeBackups: 0,
          activeMaintenance: 0,
          replicationSlots: [],
        },
      },
    },
    'postgres.config.apply': {
      content: {
        ...mapping,
        change: { changes: [{ name: 'work_mem', value: '8MB' }], reload: true },
        basis: basis('postgres.config.plan@2'),
      },
      analysis: {
        parameters: [
          {
            name: 'work_mem',
            valid: true,
            conflict: null,
            effect: 'reload',
            sourcefile: '/etc/postgresql/17/main/postgresql.conf',
          },
        ],
        managedInclude: { included: true, file: '/etc/postgresql/17/main/conf.d/exponetdb.conf' },
        needsRestart: false,
      },
    },
    'postgres.hba.apply': {
      content: {
        ...mapping,
        change: {
          managedRules: [
            {
              type: 'hostssl',
              database: 'all',
              user: 'all',
              address: '10.8.0.0/16',
              method: 'scram-sha-256',
            },
          ],
          protectedAccess: [{ role: 'exdb_reader', database: 'postgres', address: '10.8.1.1/32' }],
        },
        basis: basis('postgres.hba.inspect@2'),
      },
      analysis: {
        hbaFile: '/etc/postgresql/17/main/pg_hba.conf',
        managedBlockBefore: ['hostssl all all 10.8.0.0/16 scram-sha-256'],
        foreignRules: 3,
        managedRulesAfter: 1,
        protectedAccess: {
          requested: 1,
          derived: [{ role: 'exdb_migrator', address: '10.8.1.1/32' }],
        },
      },
    },
    'postgres.roles.apply': {
      content: {
        ...mapping,
        change: { steps: [{ op: 'grant_membership', role: 'reports', member: 'analyst' }] },
        basis: basis('postgres.roles.inspect@2'),
      },
      analysis: { steps: [{ op: 'grant_membership', role: 'reports', classification: 'high' }] },
    },
    'postgres.extensions.apply': {
      content: {
        ...mapping,
        change: {
          database: 'staging',
          steps: [{ op: 'create', name: 'pg_stat_statements', version: '1.11' }],
        },
        basis: basis('postgres.extensions.inspect@1'),
      },
      analysis: { database: 'staging', installedBefore: [{ name: 'plpgsql', version: '1.0' }] },
    },
    'postgres.tls.rotate': {
      content: {
        ...mapping,
        change: { dnsNames: ['pg.exdb.test'], ipAddresses: [], validityDays: 30 },
        basis: basis('postgres.tls.inspect@1'),
      },
      analysis: {
        certificateBefore: {
          notAfter: '2026-11-30T00:00:00Z',
          subject: 'CN=pg',
          path: '/etc/ssl/pg/server.crt',
        },
        ssl: { enabled: true, certFile: '/etc/ssl/pg/server.crt' },
      },
    },
  }

  const fakeRows = {
    query: async () => ({
      rows: [
        {
          text: (c: string) =>
            c === 'content_checksum' ? `sha256:${'a'.repeat(64)}` : '2026-10-28T10:00:00.000000Z',
          textOrNull: () => null,
          int: () => 0,
        },
      ],
    }),
  }
  const record = (kind: string, content: object, analysis: object) =>
    ({
      planId: 'pln_01M5ZF4EQW8F0GGEAV93NKAA98',
      kind,
      kindVersion: 1,
      actionClass: 'high',
      state: 'active',
      decision: 'allow',
      planHash: `sha256:pv1:${'b'.repeat(64)}`,
      policyVersion: 'v',
      actor: {
        kind: 'human',
        identityId: 'idn_01M4H5XZ12G122Q9MCZHT5QKMA',
        client: 'cli',
        clientId: null,
      },
      expiresAt: new Date(),
      body: {
        subject: { clusterId: CLUSTER, nodeId: NODE, tier: 'nonprod' },
        content,
        analysis,
        policy: { requirements: [] },
      },
    }) as never

  for (const [kind, body] of Object.entries(bodies)) {
    it(`shows the change of ${kind} and leaves the host's paths out`, async () => {
      const view = await planView(fakeRows as never, record(kind, body.content, body.analysis))
      const change = (view as unknown as { change?: { content: object; analysis: object } }).change
      expect(change, kind).toBeDefined()
      const shown = JSON.stringify(change)
      expect(change?.content).toMatchObject({ change: (body.content as { change: object }).change })
      // No file or directory of the host, whatever its key.
      expect(shown, kind).not.toMatch(/"(dataDirectory|hbaFile|sourcefile|file|path|certFile)"/)
      expect(shown, kind).not.toContain('/etc/')
      expect(shown, kind).not.toContain('/var/lib/')
      // And nothing that holds a secret.
      expect(shown, kind).not.toMatch(/verifier|password|secret|privateKey/i)
    })
  }

  it('shows the hba diff and what a restart would sever', async () => {
    const hba = bodies['postgres.hba.apply'] as { content: object; analysis: object }
    const hbaView = (await planView(
      fakeRows as never,
      record('postgres.hba.apply', hba.content, hba.analysis),
    )) as unknown as {
      change: { content: { change: object }; analysis: Record<string, unknown> }
    }
    expect(hbaView.change.analysis).toMatchObject({
      managedBlockBefore: ['hostssl all all 10.8.0.0/16 scram-sha-256'],
      foreignRules: 3,
      managedRulesAfter: 1,
      protectedAccess: { requested: 1 },
    })
    expect(hbaView.change.content.change).toMatchObject({
      protectedAccess: [{ role: 'exdb_reader' }],
    })
    const restart = bodies['postgres.restart'] as { content: object; analysis: object }
    const restartView = (await planView(
      fakeRows as never,
      record('postgres.restart', restart.content, restart.analysis),
    )) as unknown as {
      change: { analysis: { observed: { connections: object[] } } }
    }
    expect(restartView.change.analysis.observed.connections).toEqual([
      { role: 'staging_app', count: 9 },
    ])
  })

  it('shows no change for a node kind outside the seven (a credential rotation)', async () => {
    const view = await planView(
      fakeRows as never,
      record('credential.rotate', { clusterId: CLUSTER }, { b: 2 }),
    )
    expect((view as unknown as { change?: unknown }).change).toBeUndefined()
  })
})
