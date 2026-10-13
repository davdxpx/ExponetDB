import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendAuditEvent } from '@exponetdb/audit'
import {
  createTestDatabase,
  type MigratedTestDatabase,
  migratedTestDatabase,
  type TestDatabase,
  testSuperuserUrl,
} from '@exponetdb/control-store/testing'
import { expectOk, parseId, systemClock } from '@exponetdb/kernel'
import { generateKeyringText } from '@exponetdb/secrets'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCommand } from '../src/commands/index.ts'
import type { GatewayConfig, ServeConfig, WorkerConfig } from '../src/config/env.ts'
import { runGateway, runServe, runWorker } from '../src/roles/roles.ts'

/**
 * The program against PostgreSQL 17: migrate from empty, the three roles
 * from one build with their own logins, readiness that tells the truth,
 * refusals of unsafe starts, graceful shutdown and the operator commands.
 */
let db: MigratedTestDatabase
let dir = ''
const keyring = generateKeyringText('k2026a')

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_server')
  dir = await mkdtemp(join(tmpdir(), 'exdb-server-'))
})

afterAll(async () => {
  await db?.drop()
  await rm(dir, { recursive: true, force: true })
})

const common = {
  logLevel: 'warn' as const,
  otlpEndpoint: undefined,
  internalListen: { host: '127.0.0.1', port: 0 },
  shutdownTimeoutMs: 10_000,
  keyringEnv: { EXPONETDB_KEYRING: keyring },
}

const serveConfig = (overrides: Partial<ServeConfig> = {}): ServeConfig => ({
  ...common,
  role: 'serve',
  controlStoreUrl: db.url('exdb_serve'),
  installationId: db.installationId,
  listen: { host: '127.0.0.1', port: 0 },
  publicUrl: 'http://localhost:8080',
  webauthnRpId: undefined,
  trustedProxies: [],
  egressAddresses: [],
  mcpAllowedOrigins: [],
  ...overrides,
})

interface Running {
  readonly ports: { readonly public?: number; readonly internal: number }
  readonly stop: () => Promise<number>
  readonly logs: string[]
}

async function start(
  run: (hooks: {
    until: Promise<unknown>
    write: (l: string) => void
    onListening: (p: Running['ports']) => void
  }) => Promise<number>,
): Promise<Running> {
  let release: () => void = () => undefined
  const until = new Promise<void>((resolve) => {
    release = resolve
  })
  const logs: string[] = []
  let ports: Running['ports'] | undefined
  let listening: () => void = () => undefined
  const ready = new Promise<void>((resolve) => {
    listening = resolve
  })
  const exit = run({
    until,
    write: (l) => logs.push(l),
    onListening: (p) => {
      ports = p
      listening()
    },
  })
  const first = await Promise.race([
    ready.then(() => 'listening' as const),
    exit.then((code) => code),
  ])
  if (first !== 'listening' || ports === undefined) {
    throw new Error(`role exited with ${String(first)}: ${logs.join('\n')}`)
  }
  return {
    ports,
    logs,
    stop: async () => {
      release()
      return exit
    },
  }
}

async function get(
  port: number | undefined,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port ?? 0}${path}`)
  return { status: res.status, body: JSON.parse(await res.text()) }
}

async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (ok(v) || Date.now() > deadline) {
      return v
    }
    await new Promise((r) => setTimeout(r, 200))
  }
}

function io(env: Record<string, string>) {
  const out: string[] = []
  const err: string[] = []
  return {
    io: { env, stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) },
    out,
    err,
  }
}

describe('the three roles from one build', () => {
  it('serve: probes only; ready once the schema, installation, login and keyring check out', async () => {
    const serve = await start((hooks) => runServe(serveConfig(), hooks))
    const live = await get(serve.ports.public, '/healthz/live')
    expect(live).toMatchObject({ status: 200, body: { status: 'up' } })
    const ready = await eventually(
      () => get(serve.ports.public, '/healthz/ready'),
      (r) => r.status === 200,
    )
    // No worker runs yet: degraded (still serving), never "ready" by default.
    expect(ready).toMatchObject({ status: 200, body: { status: 'degraded' } })
    expect(Object.keys(ready.body).sort()).toEqual(['requestId', 'status'])
    const detail = await get(serve.ports.internal, '/healthz/detail')
    expect(detail.body['version']).toEqual(expect.any(String))
    expect(detail.body['checks']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'schema', status: 'pass' }),
        expect.objectContaining({ name: 'installation', status: 'pass' }),
        expect.objectContaining({ name: 'role_credential', status: 'pass' }),
        expect.objectContaining({ name: 'keyring', status: 'pass' }),
        expect.objectContaining({ name: 'workers', status: 'warn', reason: 'no_live_worker' }),
      ]),
    )
    // A route of a later wave is not served; a Wave 4 or 5 route needs a credential.
    const later = await get(
      serve.ports.public,
      '/api/v1/clusters/cls_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z/backups',
    )
    expect(later).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } })
    const nodes = await get(serve.ports.public, '/api/v1/nodes')
    expect(nodes).toMatchObject({ status: 401, body: { code: 'UNAUTHENTICATED' } })
    const api = await get(serve.ports.public, '/api/v1/targets')
    expect(api).toMatchObject({ status: 401, body: { code: 'UNAUTHENTICATED' } })
    expect(await serve.stop()).toBe(0)
    const { rows } = await db
      .store('exdb_serve')
      .query(
        'test.heartbeats',
        `SELECT stopped_at IS NOT NULL AS stopped FROM control.process_heartbeats WHERE role = 'serve'`,
      )
    expect(rows.every((r) => r.bool('stopped'))).toBe(true)
  })

  it('worker: runs the maintenance tasks, exports checkpoints, and becomes ready', async () => {
    const exportDir = join(dir, 'checkpoints')
    const config: WorkerConfig = {
      ...common,
      role: 'worker',
      controlStoreUrl: db.url('exdb_worker'),
      installationId: db.installationId,
      auditExport: { kind: 'file', directory: exportDir },
    }
    // Something to anchor: an audited event before the worker's first checkpoint.
    await db.store('exdb_worker').transaction('test.audit', (tx) =>
      appendAuditEvent(
        tx,
        {
          action: 'test.recorded',
          phase: 'completed',
          actor: { kind: 'system', identityId: null, label: 'system:worker' },
        },
        { clock: systemClock },
      ),
    )
    const worker = await start((hooks) => runWorker(config, hooks))
    const tasks = await eventually(
      async () =>
        (
          await db
            .store('exdb_worker')
            .query(
              'test.tasks',
              `SELECT task, last_outcome FROM control.maintenance_tasks ORDER BY task`,
            )
        ).rows.map((r) => [r.text('task'), r.textOrNull('last_outcome')]),
      (rows) => rows.length >= 9 && rows.every(([, outcome]) => outcome !== null),
    )
    expect(Object.fromEntries(tasks)).toMatchObject({
      'audit.partitions': 'succeeded',
      'audit.checkpoint': 'succeeded',
      'audit.verify_full': expect.stringMatching(/succeeded/),
      'plans.expire': 'succeeded',
      'secrets.rewrap': 'succeeded',
    })
    const files = await readdir(join(exportDir, db.installationId, 'audit-checkpoints'))
    expect(files.length).toBeGreaterThan(0)
    const ready = await eventually(
      () => get(worker.ports.internal, '/healthz/ready'),
      (r) => r.body['status'] === 'ready',
    )
    expect(ready).toMatchObject({ status: 200, body: { status: 'ready' } })
    const metrics = await (await fetch(`http://127.0.0.1:${worker.ports.internal}/metrics`)).text()
    expect(metrics).toContain('exdb_maintenance_task_runs_total')
    expect(metrics).toContain('exdb_control_store_query_duration_seconds')
    expect(metrics).toContain('exdb_audit_chain_verified')

    // With a worker alive, serve becomes fully ready.
    const serve = await start((hooks) => runServe(serveConfig(), hooks))
    expect(
      await eventually(
        () => get(serve.ports.public, '/healthz/ready'),
        (r) => r.body['status'] === 'ready',
      ),
    ).toMatchObject({ body: { status: 'ready' } })

    // The container health probe asks the internal listener.
    const probe = io({ EXPONETDB_INTERNAL_LISTEN: `127.0.0.1:${worker.ports.internal}` })
    expect(await runCommand(['healthcheck'], probe.io)).toBe(0)
    expect(await serve.stop()).toBe(0)
    expect(await worker.stop()).toBe(0)
  })

  it('gateway without EXPONETDB_GATEWAY_LISTEN: heartbeat and readiness, no agent listener', async () => {
    const config: GatewayConfig = {
      ...common,
      role: 'gateway',
      controlStoreUrl: db.url('exdb_gateway'),
      installationId: db.installationId,
      agentListen: undefined,
    }
    const gateway = await start((hooks) => runGateway(config, hooks))
    expect(gateway.ports.public).toBeUndefined()
    expect(
      await eventually(
        () => get(gateway.ports.internal, '/healthz/ready'),
        (r) => r.status === 200,
      ),
    ).toMatchObject({ status: 200 })
    const detail = await get(gateway.ports.internal, '/healthz/detail')
    expect(JSON.stringify(detail.body)).not.toMatch(/mtls|ca_ready/i)
    await expect(
      fetch('http://127.0.0.1:7443/', { signal: AbortSignal.timeout(500) }),
    ).rejects.toThrow()
    expect(await gateway.stop()).toBe(0)
  })
})

describe('unsafe starts are refused (exit 3), unsafe states are not ready', () => {
  it('refuses another installation, another login and a newer schema', async () => {
    const write = () => undefined
    const other = expectOk(parseId('ins', 'ins_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z'), 'other installation')
    expect(await runServe(serveConfig({ installationId: other }), { write })).toBe(3)
    expect(await runServe(serveConfig({ controlStoreUrl: db.url('exdb_worker') }), { write })).toBe(
      3,
    )
    // A superuser URL is refused even when it points at the right database.
    const superuser = new URL(testSuperuserUrl())
    superuser.pathname = new URL(db.url('exdb_serve')).pathname
    expect(await runServe(serveConfig({ controlStoreUrl: superuser.toString() }), { write })).toBe(
      3,
    )
    expect(
      await runServe(
        serveConfig({
          keyringEnv: { EXPONETDB_KEYRING: '{"format":"exponetdb.keyring/v1","keys":[]}' },
        }),
        { write },
      ),
    ).toBe(3)
    await db.asSuperuser(async (c) => {
      await c.query('BEGIN')
      await c.query("SET LOCAL session_replication_role = 'replica'")
      await c.query(
        `INSERT INTO control.schema_migrations (migration_id, name, checksum, verify_digest, rollback_digest, bundle_digest, dependencies, apply_duration_ms, engine_version, pg_version_num)
         SELECT '7ZZZZZZZZZZZZZZZZZZZZZZZZZ', 'from-the-future', checksum, verify_digest, rollback_digest, bundle_digest, '{}', 1, '9.9.9', pg_version_num
           FROM control.schema_migrations LIMIT 1`,
      )
      await c.query('COMMIT')
    })
    try {
      expect(await runServe(serveConfig(), { write })).toBe(3)
    } finally {
      await db.asSuperuser(async (c) => {
        await c.query('BEGIN')
        await c.query("SET LOCAL session_replication_role = 'replica'")
        await c.query(
          `DELETE FROM control.schema_migrations WHERE migration_id = '7ZZZZZZZZZZZZZZZZZZZZZZZZZ'`,
        )
        await c.query('COMMIT')
      })
    }
  })

  it('an unmigrated Control Store keeps the process running and not ready', async () => {
    const empty: TestDatabase = await createTestDatabase('exdb_it_server_empty')
    try {
      const serve = await start((hooks) =>
        runServe(serveConfig({ controlStoreUrl: empty.url('exdb_serve') }), hooks),
      )
      const ready = await get(serve.ports.public, '/healthz/ready')
      expect(ready).toMatchObject({ status: 503, body: { status: 'not_ready' } })
      expect(await serve.stop()).toBe(0)
    } finally {
      await empty.drop()
    }
  })
})

describe('operator commands', () => {
  it('migrate from empty, then a second run is a no-op', async () => {
    const empty = await createTestDatabase('exdb_it_server_migrate')
    try {
      const first = io({
        EXPONETDB_CONTROL_STORE_URL: empty.url('exdb_migrate'),
        EXPONETDB_LOG_LEVEL: 'warn',
      })
      expect(await runCommand(['control-store', 'migrate'], first.io)).toBe(0)
      const report = JSON.parse(first.out.join(''))
      expect(report.applied.length).toBeGreaterThanOrEqual(6)
      expect(report.state.status).toBe('current')
      const second = io({
        EXPONETDB_CONTROL_STORE_URL: empty.url('exdb_migrate'),
        EXPONETDB_LOG_LEVEL: 'warn',
      })
      expect(await runCommand(['control-store', 'migrate'], second.io)).toBe(0)
      expect(JSON.parse(second.out.join(''))).toMatchObject({
        applied: [],
        verifications: [],
        installationId: report.installationId,
      })
      const wrong = io({ EXPONETDB_CONTROL_STORE_URL: empty.url('exdb_serve') })
      expect(await runCommand(['control-store', 'migrate'], wrong.io)).toBe(1)
      expect(wrong.err.join('')).toContain('migrate_wrong_role')
      expect(wrong.err.join('')).not.toContain(new URL(empty.url('exdb_serve')).password)
      const superuser = new URL(testSuperuserUrl())
      superuser.pathname = new URL(empty.url('exdb_migrate')).pathname
      const privileged = io({ EXPONETDB_CONTROL_STORE_URL: superuser.toString() })
      expect(await runCommand(['control-store', 'migrate'], privileged.io)).toBe(1)
      expect(privileged.err.join('')).toContain('migrate_wrong_role')
      expect(privileged.err.join('')).not.toContain(superuser.password)
    } finally {
      await empty.drop()
    }
  })

  it('audit verify is read-only and passes; prune needs the maintenance login and keeps everything by default', async () => {
    const verify = io({
      EXPONETDB_CONTROL_STORE_URL: db.url('exdb_serve'),
      EXPONETDB_LOG_LEVEL: 'warn',
    })
    expect(await runCommand(['audit', 'verify'], verify.io)).toBe(0)
    expect(JSON.parse(verify.out.join(''))).toMatchObject({ ok: true })
    const prune = io({
      EXPONETDB_CONTROL_STORE_URL: db.url('exdb_audit_maint'),
      EXPONETDB_LOG_LEVEL: 'warn',
    })
    expect(await runCommand(['audit', 'prune'], prune.io)).toBe(0)
    expect(JSON.parse(prune.out.join(''))).toEqual({
      retention: { kind: 'permanent' },
      pruned: [],
      remaining: 0,
    })
    const wrong = io({ EXPONETDB_CONTROL_STORE_URL: db.url('exdb_worker') })
    expect(await runCommand(['audit', 'prune'], wrong.io)).toBe(2)
    expect(await runCommand(['audit', 'verify', '--fix'], verify.io)).toBe(2)
  })

  it('status, keyring status and version', async () => {
    const status = io({ EXPONETDB_CONTROL_STORE_URL: db.url('exdb_gateway') })
    expect(await runCommand(['control-store', 'status'], status.io)).toBe(0)
    expect(JSON.parse(status.out.join(''))).toMatchObject({
      status: 'current',
      installationId: db.installationId,
    })
    const keys = io({
      EXPONETDB_CONTROL_STORE_URL: db.url('exdb_worker'),
      EXPONETDB_KEYRING: keyring,
    })
    expect(await runCommand(['keyring', 'status'], keys.io)).toBe(0)
    const report = JSON.parse(keys.out.join(''))
    expect(report).toMatchObject({ activeKeyId: 'k2026a', missing: [], mismatched: [] })
    expect(keys.out.join('')).not.toContain(JSON.parse(keyring).keys[0].key)
    const version = io({})
    expect(await runCommand(['version'], version.io)).toBe(0)
    expect(JSON.parse(version.out.join(''))).toMatchObject({
      version: expect.any(String),
      commit: expect.any(String),
    })
  })

  it('keyring rotate-mcp-key: the serve login only, prints the purpose and version, never a key', async () => {
    const rotate = (login: Parameters<typeof db.url>[0], purpose: string) => {
      const r = io({ EXPONETDB_CONTROL_STORE_URL: db.url(login), EXPONETDB_KEYRING: keyring })
      return { r, run: () => runCommand(['keyring', 'rotate-mcp-key', '--purpose', purpose], r.io) }
    }
    const worker = rotate('exdb_worker', 'mcp.request_state_key')
    expect(await worker.run()).toBe(2)
    expect(worker.r.err.join('')).toContain('serve_login_required')
    const wrong = rotate('exdb_serve', 'audit.pseudonym_key')
    expect(await wrong.run()).toBe(2)
    for (const expected of [1, 2]) {
      // The first call creates the key (version 1), the second rotates it.
      const serve = rotate('exdb_serve', 'mcp.request_state_key')
      expect(await serve.run()).toBe(0)
      expect(JSON.parse(serve.r.out.join(''))).toEqual({
        purpose: 'mcp.request_state_key',
        version: expected,
      })
    }
    const versions = await db.asSuperuser((c) =>
      c.query(
        `SELECT max(version)::int AS v FROM secrets.secret_versions WHERE purpose = 'mcp.request_state_key'`,
      ),
    )
    expect(versions.rows[0]?.v).toBe(2)
  })

  it('bootstrap-sql and keyring generate write secrets only to new 0600 files', async () => {
    const credentials = join(dir, 'credentials.env')
    const script = join(dir, 'bootstrap.sql')
    const run = io({})
    expect(
      await runCommand(
        ['control-store', 'bootstrap-sql', '--credentials-file', credentials, '--output', script],
        run.io,
      ),
    ).toBe(0)
    expect(run.out.join('')).toBe('')
    expect((await stat(credentials)).mode & 0o777).toBe(0o600)
    const sql = await readFile(script, 'utf8')
    const passwords = (await readFile(credentials, 'utf8'))
      .split('\n')
      .filter((l) => l.startsWith('exdb_'))
      .map((l) => l.split('=')[1] ?? '')
    expect(passwords).toHaveLength(5)
    for (const p of passwords) {
      expect(p.length).toBeGreaterThan(20)
      expect(sql).not.toContain(p)
    }
    expect(sql).toContain('SCRAM-SHA-256$4096:')
    expect(
      await runCommand(
        ['control-store', 'bootstrap-sql', '--credentials-file', credentials],
        io({}).io,
      ),
    ).toBe(1)
    const keyFile = join(dir, 'keyring.json')
    expect(
      await runCommand(
        ['keyring', 'generate', '--key-id', 'k2026b', '--output', keyFile],
        io({}).io,
      ),
    ).toBe(0)
    expect((await stat(keyFile)).mode & 0o777).toBe(0o600)
    expect(
      await runCommand(
        ['keyring', 'generate', '--key-id', 'k2026b', '--output', keyFile],
        io({}).io,
      ),
    ).toBe(1)
  })

  it('bootstrap owner and auth recover-owner: links on standard output only, refusals exit 2', async () => {
    const env = {
      EXPONETDB_CONTROL_STORE_URL: db.url('exdb_serve'),
      EXPONETDB_PUBLIC_URL: 'https://db.example.test',
    }
    const first = io(env)
    expect(
      await runCommand(['bootstrap', 'owner', '--email', 'first@example.test'], first.io),
    ).toBe(0)
    const issued: { identityId: string; setupLink: string; reissued: boolean } = JSON.parse(
      first.out.join(''),
    )
    expect(issued.setupLink).toMatch(
      /^https:\/\/db\.example\.test\/setup#token=exsu_[A-Za-z0-9_-]{43}$/,
    )
    expect(issued.reissued).toBe(false)
    const token = issued.setupLink.split('#token=')[1] ?? ''
    expect(first.err.join('')).not.toContain(token)

    const again = io(env)
    expect(
      await runCommand(['bootstrap', 'owner', '--email', 'first@example.test'], again.io),
    ).toBe(2)
    expect(again.err.join('')).toContain('refused (bootstrap_pending)')

    const reissue = io(env)
    expect(
      await runCommand(
        ['bootstrap', 'owner', '--email', 'corrected@example.test', '--reissue'],
        reissue.io,
      ),
    ).toBe(0)
    const second: { identityId: string; setupLink: string; reissued: boolean } = JSON.parse(
      reissue.out.join(''),
    )
    expect(second).toMatchObject({ identityId: issued.identityId, reissued: true })
    expect(second.setupLink).not.toBe(issued.setupLink)

    const short = join(dir, 'short-reason.txt')
    await writeFile(short, 'too short')
    const tooShort = io(env)
    expect(
      await runCommand(
        ['auth', 'recover-owner', '--email', 'corrected@example.test', '--reason-file', short],
        tooShort.io,
      ),
    ).toBe(2)
    expect(tooShort.err.join('')).toContain('refused (recovery_reason_invalid)')
    // A pending first owner is not an active owner: nothing to recover.
    const reason = join(dir, 'reason.txt')
    await writeFile(reason, 'Lost every passkey and the authenticator app while travelling.')
    const pending = io(env)
    expect(
      await runCommand(
        ['auth', 'recover-owner', '--email', 'corrected@example.test', '--reason-file', reason],
        pending.io,
      ),
    ).toBe(2)
    expect(pending.err.join('')).toContain('refused (recovery_no_owner)')

    // Only the serve login may run them.
    const worker = io({ ...env, EXPONETDB_CONTROL_STORE_URL: db.url('exdb_worker') })
    expect(
      await runCommand(
        ['bootstrap', 'owner', '--email', 'corrected@example.test', '--reissue'],
        worker.io,
      ),
    ).not.toBe(0)
    expect(worker.out.join('')).toBe('')
  })

  it('unknown commands and flags are usage errors', async () => {
    for (const argv of [
      ['nonsense'],
      ['serve', 'extra'],
      ['keyring', 'generate', '--force', 'x'],
      ['control-store', 'migrate', '--rewrite', 'x'],
    ]) {
      const r = io({})
      expect(await runCommand(argv, r.io), argv.join(' ')).toBe(2)
    }
  })
})
