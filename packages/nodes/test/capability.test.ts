import { createHash, createHmac, generateKeyPairSync, pbkdf2Sync, sign } from 'node:crypto'
import { canonicalBytes } from '@exponetdb/kernel'
import { b64u } from '@exponetdb/kernel/node'
import { describe, expect, it } from 'vitest'
import {
  bundleTrusts,
  hbaRuleShows,
  managedParameters,
  outcomeOf,
  pemCertificates,
  rejectionCode,
  restartDigest,
  roleExpectations,
  rolesShow,
  scramVerifier,
  tlsProofValid,
} from '../src/index.ts'

describe('job ends (control-plane.md §9.4)', () => {
  const cap = 'postgres.config.apply@1' as const

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

describe('the managed fragment', () => {
  it('reads the fragment rows in file order, the last value winning', () => {
    const inspect = {
      managedInclude: { path: '/etc/postgresql/17/main/conf.d/exponetdb.conf' },
      fileSettings: [
        { sourcefile: '/etc/postgresql/17/main/postgresql.conf', name: 'work_mem', setting: '4MB' },
        {
          sourcefile: '/etc/postgresql/17/main/conf.d/exponetdb.conf',
          name: 'work_mem',
          setting: '8MB',
        },
        {
          sourcefile: '/etc/postgresql/17/main/conf.d/exponetdb.conf',
          name: 'jit',
          setting: 'off',
        },
        {
          sourcefile: '/etc/postgresql/17/main/conf.d/exponetdb.conf',
          name: 'work_mem',
          setting: '16MB',
        },
        { sourcefile: '/etc/postgresql/17/main/conf.d/exponetdb.conf', name: null, setting: null },
      ],
    }
    expect([...managedParameters(inspect)]).toEqual([
      ['work_mem', '16MB'],
      ['jit', 'off'],
    ])
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
    settings: [{ role: 'app', database: null, name: 'work_mem', value: '32MB' }],
  }

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
    const reset = [...steps, step({ op: 'reset_role_setting', role: 'app', setting: 'work_mem' })]
    expect(rolesShow(inspect, roleExpectations(reset))).toBe(false)
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
          options: ['map=m'],
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
