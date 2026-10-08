import { createHash, createHmac, generateKeyPairSync, pbkdf2Sync, sign } from 'node:crypto'
import { canonicalBytes } from '@exponetdb/kernel'
import { b64u } from '@exponetdb/kernel/node'
import { describe, expect, it } from 'vitest'
import {
  bundleTrusts,
  configHostState,
  configRuns,
  fragmentHolds,
  hbaRuleShows,
  outcomeOf,
  pemCertificates,
  rejectionCode,
  restartDigest,
  roleExpectations,
  rolesShow,
  scramVerifier,
  settingExpectations,
  tlsProofValid,
} from '../src/index.ts'

describe('job ends (control-plane.md §9.4)', () => {
  const cap = 'postgres.config.apply@2' as const

  it('a failure before the effect point did not change the host', () => {
    expect(
      outcomeOf({ end: 'failed', jobId: 'j', effectBegan: false, precondition: true }, cap),
    ).toMatchObject({ outcome: 'not_applied', errorCode: 'PLAN_STALE' })
    expect(
      outcomeOf({ end: 'failed', jobId: 'j', effectBegan: false, precondition: false }, cap),
    ).toMatchObject({ outcome: 'not_applied', errorCode: 'NODE_CAPABILITY_FAILED' })
  })

  it('a failure after the effect point is unknown, as is anything unproven', () => {
    expect(
      outcomeOf({ end: 'failed', jobId: 'j', effectBegan: true, precondition: false }, cap),
    ).toBe('unknown')
    for (const why of [
      'signature',
      'delivery_rejection',
      'schema',
      'outcome_unknown',
      'lease_lost',
    ]) {
      expect(outcomeOf({ end: 'unproven', jobId: 'j', why }, cap)).toBe('unknown')
    }
  })

  it('a job that never ran is not applied, with the reason as a catalog code', () => {
    expect(outcomeOf({ end: 'expired', jobId: 'j' }, cap)).toMatchObject({
      errorCode: 'JOB_EXPIRED',
    })
    expect(outcomeOf({ end: 'canceled', jobId: 'j', revoked: true }, cap)).toMatchObject({
      errorCode: 'NODE_REVOKED',
    })
    expect(outcomeOf({ end: 'canceled', jobId: 'j', revoked: false }, cap)).toBe('not_applied')
    expect(rejectionCode('precondition_failed')).toBe('NODE_CAPABILITY_FAILED')
    expect(rejectionCode('capability_disabled')).toBe('CAPABILITY_UNAVAILABLE')
    expect(rejectionCode('clock_untrusted')).toBe('JOB_EXPIRED')
    expect(rejectionCode('args_invalid')).toBe('NODE_CAPABILITY_FAILED')
    expect(outcomeOf({ end: 'succeeded', jobId: 'j', result: {} }, cap)).toBeUndefined()
  })
})

describe('the managed fragment (verified on the host, F1)', () => {
  const plan = (
    rows: {
      name: string
      state: string
      applied: boolean | null
      effect?: string
      pendingRestart?: boolean
    }[],
  ) => ({
    parameters: rows.map((r) => ({
      name: r.name,
      effect: r.effect ?? 'reload',
      managed: {
        state: r.state,
        applied: r.applied,
        error: false,
        loaded: r.applied,
        pendingRestart: r.pendingRestart ?? false,
      },
    })),
  })
  const changes = [
    { name: 'work_mem', value: '16MB' },
    { name: 'jit', value: null },
  ]
  const proven = { reload: true, reloadProven: true }

  it('shows the plan when the host holds each requested value and no removed one', () => {
    expect(
      configRuns(
        plan([
          { name: 'work_mem', state: 'requested', applied: true },
          { name: 'jit', state: 'absent', applied: null },
        ]),
        changes,
        proven,
      ),
    ).toBe('shown')
  })

  it('does not when a value differs, is still there, or was not loaded', () => {
    const cases = [
      [
        { name: 'work_mem', state: 'other', applied: true },
        { name: 'jit', state: 'absent', applied: null },
      ],
      [
        { name: 'work_mem', state: 'requested', applied: true },
        { name: 'jit', state: 'other', applied: true },
      ],
      [
        { name: 'work_mem', state: 'requested', applied: false },
        { name: 'jit', state: 'absent', applied: null },
      ],
      [{ name: 'work_mem', state: 'requested', applied: true }],
    ]
    for (const rows of cases) {
      expect(configRuns(plan(rows), changes, proven)).toBe('not_shown')
    }
    // A change that waits for a restart is not loaded yet, and that is fine.
    expect(
      configRuns(
        plan([
          {
            name: 'work_mem',
            state: 'requested',
            applied: false,
            effect: 'restart',
            pendingRestart: true,
          },
          { name: 'jit', state: 'absent', applied: null },
        ]),
        changes,
        proven,
      ),
    ).toBe('shown')
  })

  it('needs the proof of the reload for a removal too (correction review, round 6)', () => {
    const removed = plan([{ name: 'jit', state: 'absent', applied: null }])
    const removal = [{ name: 'jit', value: null }]
    // The line is gone from the files; nothing proves the server stopped
    // running it (a reconciled operation has no statement).
    expect(configRuns(removed, removal, { reload: true })).toBe('unknown')
    expect(configRuns(removed, removal, proven)).toBe('shown')
    // Written without a reload: the files are the change.
    expect(configRuns(removed, removal, { reload: false })).toBe('shown')
  })
})

describe('a withheld value in the managed fragment (correction review, round 2)', () => {
  const plan = (state: string) => ({
    parameters: [
      {
        name: 'myext.api_key',
        effect: 'reload',
        managed: { state, applied: true, error: false, loaded: true },
      },
    ],
  })
  const changes = [{ name: 'myext.api_key', value: 'written by the plan' }]

  it('is never compared on the host, so it shows the plan only with the proof of the fragment digest', () => {
    // The node never says whether it is the requested value.
    expect(fragmentHolds(plan('held'), changes)).toBe(false)
    expect(configRuns(plan('held'), changes, { reload: true, reloadProven: true })).toBe(
      'not_shown',
    )
    // The fragment is byte for byte what the signed apply statement reported.
    expect(fragmentHolds(plan('held'), changes, true)).toBe(true)
    expect(
      configRuns(plan('held'), changes, { reload: true, heldProven: true, reloadProven: true }),
    ).toBe('shown')
    expect(fragmentHolds(plan('other'), changes, true)).toBe(false)
    expect(fragmentHolds(plan('absent'), changes, true)).toBe(false)
  })
})

describe('reconciling a configuration change whose job proved nothing (correction review, round 3)', () => {
  const plan = (state: string) => ({
    parameters: [
      {
        name: 'myext.api_key',
        effect: 'reload',
        managed: { state, applied: true, error: false, loaded: true },
      },
    ],
  })
  const changes = [{ name: 'myext.api_key', value: 'the value it already had' }]

  it('never reads an unchanged fragment as not applied when a planned value is withheld', () => {
    // The job may have written the value the fragment already held: same bytes.
    expect(configHostState({ plan: plan('held'), changes, proven: false, unchanged: true })).toBe(
      'unknown',
    )
    expect(configHostState({ plan: plan('held'), changes, proven: true, unchanged: false })).toBe(
      'applied',
    )
    // A shown value still decides: unchanged and not the requested value.
    expect(configHostState({ plan: plan('other'), changes, proven: false, unchanged: true })).toBe(
      'not_applied',
    )
    expect(
      configHostState({ plan: plan('requested'), changes, proven: false, unchanged: true }),
    ).toBe('applied')
    expect(configHostState({ plan: plan('other'), changes, proven: false, unchanged: false })).toBe(
      'unknown',
    )
  })
})

describe('a configuration change is loaded only when the server runs its line (correction review, rounds 4 to 7)', () => {
  const plan = (managed: Record<string, unknown>, effect = 'reload', context = 'user') => ({
    parameters: [
      {
        name: 'work_mem',
        effect,
        context,
        managed: { state: 'requested', error: false, pendingRestart: false, ...managed },
      },
    ],
  })
  const changes = [{ name: 'work_mem', value: '9MB' }]
  const reload = { reload: true }
  const proven = { reload: true, reloadProven: true }

  it('needs the proof of the reload by the job itself, the line effective and no other source named', () => {
    // pg_file_settings says applied for a file the server has not reloaded,
    // and pg_settings still names the same line after a rewrite in place:
    // without the job's statement nothing proves the reload.
    expect(configRuns(plan({ applied: true, loaded: true }), changes, reload)).toBe('unknown')
    expect(configRuns(plan({ applied: true, loaded: true }), changes, proven)).toBe('shown')
    // Another source runs: a later line, or one that outranks every file
    // (the command line, ALTER ROLE ALL, an override; round 6).
    expect(configRuns(plan({ applied: true, loaded: false }), changes, proven)).toBe('not_shown')
    expect(configRuns(plan({ applied: false, loaded: null }), changes, proven)).toBe('not_shown')
    // pg_settings does not show a custom parameter, or the agent's own
    // session hides the server's source: the proven reload and the
    // effective line decide.
    expect(configRuns(plan({ applied: true, loaded: null }), changes, proven)).toBe('shown')
    expect(configRuns(plan({ applied: true, loaded: null }), changes, reload)).toBe('unknown')
    // Written without a reload: the line must still be the effective one.
    expect(configRuns(plan({ applied: true, loaded: false }), changes, { reload: false })).toBe(
      'shown',
    )
    expect(configRuns(plan({ applied: false, loaded: false }), changes, { reload: false })).toBe(
      'not_shown',
    )
  })

  it('takes a restart-only line as in place when it waits for the restart or already runs', () => {
    // Waits for the restart: not an error, also without a reload.
    for (const options of [reload, { reload: false }]) {
      expect(
        configRuns(
          plan({ applied: false, loaded: false, pendingRestart: true }, 'restart', 'postmaster'),
          changes,
          options,
        ),
      ).toBe('shown')
    }
    // Pinned to the value the server runs (round 6): PostgreSQL compared the
    // line with the running value and the node reports it loaded, although
    // pg_settings keeps naming the default as its source.
    expect(
      configRuns(plan({ applied: true, loaded: true }, 'none', 'postmaster'), changes, reload),
    ).toBe('shown')
    // A later line overrides it, or a source a restart never changes wins:
    // neither waits for a restart nor runs.
    expect(
      configRuns(plan({ applied: false, loaded: false }, 'restart', 'postmaster'), changes, proven),
    ).toBe('not_shown')
    expect(
      configRuns(
        plan({ applied: false, loaded: false, error: true }, 'restart', 'postmaster'),
        changes,
        proven,
      ),
    ).toBe('not_shown')
  })

  it('never takes a line in place that a reported conflict outranks, reload or not (round 7)', () => {
    const outranked = {
      parameters: [
        {
          name: 'work_mem',
          effect: 'reload',
          context: 'user',
          conflict: 'source_overrides',
          managed: { state: 'requested', applied: true, error: false, loaded: null },
        },
      ],
    }
    expect(configRuns(outranked, changes, { reload: false })).toBe('not_shown')
    expect(configRuns(outranked, changes, proven)).toBe('not_shown')
    // The files still hold it: reconciliation reads the write as applied.
    expect(fragmentHolds(outranked, changes)).toBe(true)
  })

  it('reconciles an unchanged fragment holding a requested value that does not run as unknown', () => {
    expect(
      configHostState({
        plan: plan({ applied: false, loaded: false, error: true }),
        changes,
        proven: false,
        unchanged: true,
      }),
    ).toBe('unknown')
  })
})

describe('role expectations', () => {
  const step = (o: Record<string, unknown>) => ({
    attributes: null,
    verifier: null,
    member: null,
    admin: null,
    inherit: null,
    set: null,
    database: null,
    setting: null,
    value: null,
    ...o,
  })
  const steps = [
    step({ op: 'create_role', role: 'app', attributes: { login: true, createdb: null } }),
    step({
      op: 'grant_membership',
      role: 'readers',
      member: 'app',
      admin: false,
      inherit: true,
      set: false,
    }),
    step({ op: 'set_role_setting', role: 'app', setting: 'work_mem', value: '32MB' }),
    step({ op: 'alter_role', role: 'app', attributes: { connectionLimit: 5 } }),
  ]
  const inspect = {
    roles: [{ name: 'app', login: true, createdb: false, connectionLimit: 5, password: 'none' }],
    memberships: [{ role: 'readers', member: 'app', admin: false, inherit: true, set: false }],
    settings: [
      { role: 'app', database: null, name: 'work_mem', value: { withheld: 'unclassified' } },
    ],
    expectations: [{ holds: true }],
  }

  it('ask the host to compare each setting, never reading the value back (F1)', () => {
    expect(settingExpectations(roleExpectations(steps))).toEqual([
      { role: 'app', database: null, name: 'work_mem', value: '32MB' },
    ])
    const inDb = [
      step({ op: 'reset_role_setting', role: 'app', setting: 'work_mem', database: 'db' }),
    ]
    expect(settingExpectations(roleExpectations(inDb))).toEqual([
      { role: 'app', database: 'db', name: 'work_mem', value: null },
    ])
  })

  it('are met when the inspection shows the folded state', () => {
    expect(rolesShow(inspect, roleExpectations(steps))).toBe(true)
  })

  it('are not met when one part is missing or different', () => {
    expect(rolesShow({ ...inspect, memberships: [] }, roleExpectations(steps))).toBe(false)
    expect(
      rolesShow(
        { ...inspect, roles: [{ ...inspect.roles[0], connectionLimit: -1 }] },
        roleExpectations(steps),
      ),
    ).toBe(false)
    expect(
      rolesShow({ ...inspect, expectations: [{ holds: false }] }, roleExpectations(steps)),
    ).toBe(false)
    expect(rolesShow({ ...inspect, expectations: [] }, roleExpectations(steps))).toBe(false)
    const password = [step({ op: 'set_password', role: 'app', verifier: { ns1: {} } })]
    expect(rolesShow(inspect, roleExpectations(password))).toBe(false)
  })
})

describe('TLS proof of possession (protocol.md, OD-17)', () => {
  it('verifies an ECDSA P-256 proof over the job id and the public key, r || s', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const jwk = publicKey.export({ format: 'jwk' })
    const point = Buffer.concat([
      Buffer.from([4]),
      Buffer.from(jwk.x ?? '', 'base64url'),
      Buffer.from(jwk.y ?? '', 'base64url'),
    ])
    const pub = b64u(point)
    const value = canonicalBytes({
      purpose: 'exponetdb/pgtls-pop/v1',
      jobId: 'job_A',
      publicKey: pub,
    })
    if (!value.ok) throw new Error('jcs')
    const proof = b64u(sign('sha256', value.value, { key: privateKey, dsaEncoding: 'ieee-p1363' }))
    expect(tlsProofValid('job_A', pub, proof)).toBe(true)
    expect(tlsProofValid('job_B', pub, proof)).toBe(false)
    expect(tlsProofValid('job_A', pub, b64u(new Uint8Array(64)))).toBe(false)
    expect(tlsProofValid('job_A', 'AAAA', proof)).toBe(false)
  })
})

describe('CA bundles', () => {
  it('trust a CA only by its exact certificate', () => {
    const der = new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01])
    const pem = `-----BEGIN CERTIFICATE-----\n${Buffer.from(der).toString('base64')}\n-----END CERTIFICATE-----\n`
    expect(pemCertificates(`junk\n${pem}${pem}`)).toHaveLength(2)
    expect(bundleTrusts(pem, { certificate: der, fingerprint: '' })).toBe(true)
    expect(bundleTrusts(pem, { certificate: new Uint8Array([0x30, 0x00]), fingerprint: '' })).toBe(
      false,
    )
  })
})

describe('SCRAM-SHA-256 verifiers', () => {
  // PostgreSQL accepting a login with it is tested against a real server
  // (apps/server/test/agent-capabilities.host.test.ts, credential rotation).
  it('follow RFC 5802 and PostgreSQL storage', () => {
    const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64')
    const verifier = scramVerifier('pencil', salt, 4096)
    const salted = pbkdf2Sync('pencil', salt, 4096, 32, 'sha256')
    const stored = createHash('sha256')
      .update(createHmac('sha256', salted).update('Client Key').digest())
      .digest('base64')
    const server = createHmac('sha256', salted).update('Server Key').digest('base64')
    expect(verifier).toBe(`SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$${stored}:${server}`)
    expect(() => scramVerifier('pass word')).toThrow()
  })
})

describe('pg_hba rules as pg_hba_file_rules shows them', () => {
  const planned = {
    type: 'hostssl',
    database: ['app'],
    user: ['app_user'],
    address: '10.1.0.0/16',
    method: 'scram-sha-256',
    map: null,
  }
  const seen = {
    type: 'hostssl',
    database: ['app'],
    userName: ['app_user'],
    address: '10.1.0.0',
    netmask: '255.255.0.0',
    authMethod: 'scram-sha-256',
    options: [],
  }

  it('match field by field, address with its mask', () => {
    expect(hbaRuleShows(planned, seen)).toBe(true)
    expect(hbaRuleShows(planned, { ...seen, netmask: '255.255.255.0' })).toBe(false)
    expect(hbaRuleShows(planned, { ...seen, userName: ['other'] })).toBe(false)
    expect(hbaRuleShows(planned, { ...seen, authMethod: 'trust' })).toBe(false)
    expect(hbaRuleShows(planned, undefined)).toBe(false)
    expect(
      hbaRuleShows(
        { ...planned, address: 'fd00:10::/64' },
        { ...seen, address: 'fd00:10::', netmask: 'ffff:ffff:ffff:ffff::' },
      ),
    ).toBe(true)
    expect(
      hbaRuleShows(
        { type: 'local', database: ['all'], user: ['x'], address: null, method: 'peer', map: 'm' },
        {
          type: 'local',
          database: ['all'],
          userName: ['x'],
          address: null,
          netmask: null,
          authMethod: 'peer',
          options: [{ name: 'map', value: 'm' }],
        },
      ),
    ).toBe(true)
  })
})

describe('what a restart would disrupt', () => {
  const plan = {
    shutdownMode: 'fast',
    pendingRestart: [],
    connections: [{ role: 'app', application: null, count: 3 }],
    activeBackups: 0,
    activeMaintenance: 0,
    replicationSlots: [{ name: 'standby', active: false }],
  }

  it('binds backups, maintenance and active slots, never connections', () => {
    const base = restartDigest(plan)
    expect(restartDigest({ ...plan, connections: [] })).toBe(base)
    expect(restartDigest({ ...plan, activeBackups: 1 })).not.toBe(base)
    expect(restartDigest({ ...plan, activeMaintenance: 2 })).not.toBe(base)
    expect(
      restartDigest({ ...plan, replicationSlots: [{ name: 'standby', active: true }] }),
    ).not.toBe(base)
  })
})
