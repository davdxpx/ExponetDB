import { createHash, randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import { parseId } from '@exponetdb/kernel'
import { readSecret } from '@exponetdb/secrets'
import { describe, expect, it } from 'vitest'
import { hostScenario, PG_NAME, run } from '../support/host-world.ts'

/**
 * Host scenario: roles, extensions, TLS and credential rotation
 * (control-plane.md §9.5 to §9.7), on a cluster of its own. Typed role steps
 * against a fresh digest; ExponetDB's own roles never changed by a plan; an
 * extension in a fresh database; a TLS key made on the host with a
 * certificate from the PostgreSQL CA that a fresh connection presents; and
 * two credential rotations, after which only the newest password logs in
 * over verify-full.
 */
const w = hostScenario({ scenario: 'roles-tls' })

const step = (fields: Record<string, unknown>) => ({
  attributes: null,
  verifier: null,
  member: null,
  admin: null,
  inherit: null,
  set: null,
  database: null,
  setting: null,
  value: null,
  ...fields,
})

/** The sha256 of the certificate a TLS connection to the instance presents (SSLRequest first). */
async function presentedCertificate(port: number): Promise<string> {
  const { Socket } = await import('node:net')
  return new Promise((resolve, reject) => {
    const socket = new Socket()
    socket.connect(port, '127.0.0.1', () => {
      const request = Buffer.alloc(8)
      request.writeInt32BE(8, 0)
      request.writeInt32BE(80877103, 4)
      socket.write(request)
    })
    socket.once('data', (b: Buffer) => {
      if (b[0] !== 0x53) {
        reject(new Error('no TLS'))
        return
      }
      const tls = tlsConnect({ socket, rejectUnauthorized: false, servername: PG_NAME }, () => {
        const cert = tls.getPeerCertificate()
        tls.destroy()
        resolve(createHash('sha256').update(cert.raw).digest('hex'))
      })
      tls.once('error', reject)
    })
    socket.once('error', reject)
  })
}

describe('roles, extensions, TLS and credentials (host scenario)', () => {
  it('applies typed role steps and never changes ExponetDB’s own roles', async () => {
    const role = `e2e_${randomBytes(4).toString('hex')}`
    await w.inspect('postgres.roles.inspect@2', { expectSettings: [] })
    const roles = await w.planAndApply({
      kind: 'postgres.roles.apply',
      steps: [
        step({
          op: 'create_role',
          role,
          attributes: {
            login: true,
            inherit: true,
            createdb: false,
            createrole: false,
            replication: false,
            bypassrls: false,
            connectionLimit: 3,
          },
        }),
        step({ op: 'set_role_setting', role, setting: 'work_mem', value: '16MB' }),
      ],
    })
    expect([roles.state, roles.verificationOutcome], w.lines.join('')).toEqual([
      'succeeded',
      'passed',
    ])
    expect(await w.psql(`SELECT rolconnlimit FROM pg_roles WHERE rolname = '${role}'`)).toBe('3')
    await w.inspect('postgres.roles.inspect@2', { expectSettings: [] })
    const own = await w.plan({
      kind: 'postgres.roles.apply',
      steps: [step({ op: 'clear_password', role: 'exponetdb_node' })],
    })
    expect([own.status, own.body?.code]).toEqual([422, 'VALIDATION_FAILED'])
  })

  it('creates an extension in a fresh database', async () => {
    const database = `e2e_${randomBytes(4).toString('hex')}`
    await w.psql(`CREATE DATABASE ${database}`)
    await w.inspect('postgres.extensions.inspect@1', { database })
    const version = await w.psql(
      `SELECT default_version FROM pg_available_extensions WHERE name = 'pg_trgm'`,
      database,
    )
    const extensions = await w.planAndApply({
      kind: 'postgres.extensions.apply',
      database,
      steps: [{ op: 'create', name: 'pg_trgm', schema: 'public', version }],
    })
    expect([extensions.state, extensions.verificationOutcome], w.lines.join('')).toEqual([
      'succeeded',
      'passed',
    ])
    expect(
      await w.psql(`SELECT extversion FROM pg_extension WHERE extname = 'pg_trgm'`, database),
    ).toBe(version)
  })

  it('rotates the TLS certificate: the key is made on the host, the certificate comes from the PostgreSQL CA', async () => {
    await w.inspect('postgres.tls.inspect@1')
    const tls = await w.planAndApply({
      kind: 'postgres.tls.rotate',
      dnsNames: [PG_NAME],
      ipAddresses: ['127.0.0.1'],
      validityDays: 30,
    })
    expect([tls.state, tls.verificationOutcome], w.lines.join('')).toEqual(['succeeded', 'passed'])
    const issued = await w.sql(
      `SELECT envelope -> 'args' -> 'certificateChain' ->> 0 AS leaf FROM nodes.jobs
        WHERE operation_id = $1 AND capability = 'postgres.tls.rotate@1'`,
      [tls.id],
    )
    expect(await presentedCertificate(w.instance.port)).toBe(
      createHash('sha256')
        .update(Buffer.from(issued[0]?.leaf ?? '', 'base64url'))
        .digest('hex'),
    )
    // No private key ever left the host: no job carries one.
    const keys = await w.sql(
      `SELECT count(*)::int AS n FROM nodes.jobs WHERE envelope::text LIKE '%PRIVATE KEY%'`,
    )
    expect(keys).toEqual([{ n: 0 }])
  })

  it('rotates a credential twice: only the newest password logs in over verify-full', async () => {
    await w.psql(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'exponetdb_observer') THEN
           CREATE ROLE exponetdb_observer LOGIN;
         END IF;
       END $$`,
    )
    await w.psql('GRANT pg_monitor TO exponetdb_observer WITH INHERIT TRUE, SET FALSE')
    const rotate = async () => {
      await w.inspect('postgres.roles.inspect@2', { expectSettings: [] })
      const planned = await w.call(
        'POST',
        `/api/v1/clusters/${w.clusterId}/credentials/observer/rotate`,
        {},
      )
      expect([planned.status, planned.body?.code], JSON.stringify(planned.body)).toEqual([
        201,
        undefined,
      ])
      await w.reauth()
      return w.finished(
        (await w.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})).body.id,
      )
    }
    const first = await rotate()
    expect([first.state, first.verificationOutcome], w.lines.join('')).toEqual([
      'succeeded',
      'passed',
    ])
    expect(
      await w.psql(
        `SELECT rolpassword LIKE 'SCRAM-SHA-256$%' FROM pg_authid WHERE rolname = 'exponetdb_observer'`,
      ),
    ).toBe('t')
    const second = await rotate()
    expect([second.state, second.verificationOutcome]).toEqual(['succeeded', 'passed'])
    const rows = await w.sql(
      `SELECT secret_id, secret_version, state FROM registry.credentials
        WHERE cluster_id = $1 AND access_role = 'observer' ORDER BY submitted_at`,
      [w.clusterId],
    )
    expect(rows.map((r) => r.state)).toEqual(['retired', 'active'])
    const passwordOf = async (row: { secret_id: string; secret_version: number }) => {
      const secretId = parseId('sec', row.secret_id)
      if (!secretId.ok) throw new Error('secret id')
      return (
        await readSecret(w.db.store('exdb_serve'), w.keyring, {
          secretId: secretId.value,
          consumer: 'observer',
          version: row.secret_version,
        })
      ).toString('utf8')
    }
    const caFile = join(w.dir, 'postgres-ca.pem')
    await writeFile(caFile, w.caPem)
    const logsIn = (password: string) =>
      run(
        'psql',
        [
          `host=127.0.0.1 port=${w.instance.port} user=exponetdb_observer dbname=postgres sslmode=verify-full sslrootcert=${caFile}`,
          '-Atc',
          'SELECT 1',
        ],
        { env: { ...process.env, PGPASSWORD: password } },
      ).then(
        () => true,
        () => false,
      )
    const retired = await passwordOf(rows[0] as never)
    const active = await passwordOf(rows[1] as never)
    expect(await logsIn(retired)).toBe(false)
    expect(await logsIn(active)).toBe(true)
    // No password or verifier appears in jobs, plans, operations, audit or the logs.
    for (const secret of [retired, active]) {
      const found = await w.sql(
        `SELECT (SELECT count(*) FROM nodes.jobs x WHERE x::text LIKE '%' || $1 || '%')
              + (SELECT count(*) FROM operations.plans x WHERE x::text LIKE '%' || $1 || '%')
              + (SELECT count(*) FROM audit.audit_events x WHERE x::text LIKE '%' || $1 || '%') AS n`,
        [secret],
      )
      expect(Number(found[0]?.n)).toBe(0)
      expect(await w.logs()).not.toContain(secret)
    }
    expect(await w.logs()).not.toContain('SCRAM-SHA-256$')
  })
})
