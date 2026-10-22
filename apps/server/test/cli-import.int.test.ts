import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { type AddressInfo, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROLE_NAMES } from '@exponetdb/postgres'
import {
  createDatabase,
  dropDatabase,
  runAsSuperuser,
  runPsql,
  SUPABASE_ALIASES,
  SUPABASE_FILES,
  serverFor,
  supabaseTargetStatements,
  withSuperuser,
} from '@exponetdb/testkit'
import { type ServerType, serve } from '@hono/node-server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type McpWorld, mcpWorld, OWNER_ROLE } from './support/mcp-int-world.ts'

/**
 * The CLI as a real process for the new commands of Wave 9 Part A (order
 * A1, A7, A8, §11): a person's CLI, holding a token for the audience `api`
 * issued by the real authorization code flow and consent, against serve's
 * public app over HTTP and the real worker, on real PostgreSQL 17:
 *
 * - A8: `cluster bootstrap-sql` for two databases before their registration,
 *   with the project's execution roles and the legacy ledger read, run with
 *   psql twice; `cluster declare-tier` plans, and applying it asks for a
 *   fresh confirmation (exit 3 without input);
 * - A7: `migration import scratch-check` is ready on the prepared targets;
 * - A1: `migration import analyze` from the project file (`layout:
 *   legacy+bundles`, the project's `baseline:<slug>`, `--hints` with a
 *   multi-file alias and the ledgers), `plan apply`, `migration import
 *   report`, `resolve` and `baseline --apply`, on the real-shape Supabase
 *   history; the observer reads the ledger only through the bootstrap
 *   SQL's grant.
 *
 * The CLI talks REST only; the test reads the databases as a superuser only
 * to check independently. EXDB_CLI_BIN runs it against an installed CLI.
 */
const CLI_MAIN = fileURLToPath(new URL('../../cli/src/main.ts', import.meta.url))
const INSTALLED_CLI = process.env['EXDB_CLI_BIN']
const CLI_COMMAND: readonly [string, readonly string[]] =
  INSTALLED_CLI === undefined || INSTALLED_CLI === ''
    ? ['bun', ['--conditions=@exponetdb/source', CLI_MAIN]]
    : [INSTALLED_CLI, []]

const pg17 = serverFor(17)
const BASELINE = 'acme-supabase-2026'
/** The test servers are shared: their ExponetDB roles keep the test kit's connection limit. */
const shared = (script: string) =>
  script.replaceAll(/CONNECTION LIMIT [0-9]+/g, 'CONNECTION LIMIT 32')

let w: McpWorld
let listener: ServerType
let base = ''
let home = ''
let repo = ''
let importedDb = ''
let scratchDb = ''
const paths = { imported: '', scratch: '' }

interface Run {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

async function cli(args: readonly string[], options: { drive?: boolean } = {}): Promise<Run> {
  const child = spawn(CLI_COMMAND[0], [...CLI_COMMAND[1], ...args], {
    cwd: repo,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: home,
      EXPONETDB_CONFIG_DIR: join(home, 'config'),
      NO_COLOR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (d: string) => {
    stdout += d
  })
  child.stderr.setEncoding('utf8').on('data', (d: string) => {
    stderr += d
  })
  let running = true
  const done = new Promise<number>((resolve) => {
    child.on('close', (code) => {
      running = false
      resolve(code ?? -1)
    })
  })
  if (options.drive === true) {
    while (running) {
      await w.drive()
      await new Promise((r) => setTimeout(r, 150))
    }
  }
  return { code: await done, stdout, stderr }
}

const json = (r: Run) => JSON.parse(r.stdout)

/** A nonprod environment of the world's product and a target on `database` in it. */
async function registerTarget(slug: string, database: string): Promise<string> {
  await w.planAndApply(`/api/v1/products/${w.ids.product}/environments`, {
    slug,
    displayName: slug,
    tier: 'nonprod',
  })
  const environments = await w.owner.browser.call(
    'GET',
    `/api/v1/products/${w.ids.product}/environments`,
  )
  const environmentId = environments.body.items.find((e: { slug: string }) => e.slug === slug).id
  const dbs = await w.owner.browser.call('GET', `/api/v1/clusters/${w.ids.cluster}/databases`)
  const databaseId = dbs.body.items.find((d: { name: string }) => d.name === database).id
  const planned = await w.owner.browser.call('POST', '/api/v1/targets', {
    projectId: w.ids.project,
    environmentId,
    databaseId,
  })
  expect(planned.status, planned.text).toBe(201)
  await w.owner.reauth()
  const applied = await w.owner.browser.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
  if (applied.body.state === 'awaiting_approval') {
    await w.owner.reauth()
    const approved = await w.owner.browser.call(
      'POST',
      `/api/v1/approvals/${applied.body.id}/approve`,
      { planHash: planned.body.planHash, acknowledgeSelfApproval: true },
    )
    expect(approved.status, approved.text).toBe(200)
  }
  await w.drive()
  return `${w.ids.slug}/platform/${slug}`
}

/** A free local port (the CLI checks that the server's OAuth issuer is the origin it calls). */
async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((r) => probe.close(() => r()))
  return port
}

beforeAll(async () => {
  const port = await freePort()
  base = `http://localhost:${port}`
  w = await mcpWorld('exdb_cli_import', { origin: base })
  listener = serve({ fetch: w.app.fetch, hostname: '127.0.0.1', port })
  await new Promise((r) => setTimeout(r, 50))
  // The import manages `public` only (the ledger's schema stays outside).
  await w.planAndApply(`/api/v1/projects/${w.ids.project}/change-plans`, {
    managedScope: { includeSchemas: ['public'], excludeSchemas: [] },
  })
  // The imported database as the history left it, its ledgers in the real shape; the observer's
  // read of them comes from the bootstrap SQL below, not from the fixture.
  importedDb = await createDatabase(pg17, `${w.ids.slug}_legacy`)
  scratchDb = await createDatabase(pg17, `${w.ids.slug}_scratch`)
  const observerGrant = /^GRANT (USAGE|SELECT) ON .*exponetdb_observer$/
  await runAsSuperuser(pg17, importedDb, [
    `GRANT USAGE, CREATE ON SCHEMA public TO ${OWNER_ROLE}`,
    ...supabaseTargetStatements(OWNER_ROLE, ROLE_NAMES.observer).filter(
      (s) => !observerGrant.test(s),
    ),
  ])
  await runAsSuperuser(pg17, scratchDb, [`GRANT USAGE, CREATE ON SCHEMA public TO ${OWNER_ROLE}`])

  // The person's CLI: the token store a `login` leaves, with a token from the real code flow.
  home = await mkdtemp(join(tmpdir(), 'exdb-cli-import-'))
  repo = join(home, 'repo')
  await mkdir(repo)
  await mkdir(join(home, 'config'), { mode: 0o700 })
  // What `login --preset admin` asks for that these commands use (nodes.read reads cluster operations).
  const scope = [
    'targets.read',
    'nodes.read',
    'schema.read',
    'migrations.read',
    'migrations.plan',
    'migrations.import',
    'registry.manage',
  ] as const
  const tokens = await w.apiTokens(scope, ['nonprod', 'prod'])
  const now = Date.now()
  await writeFile(
    join(home, 'config', 'credentials.json'),
    JSON.stringify({
      version: 1,
      credentials: {
        [base]: {
          server: base,
          clientId: 'exponetdb-cli',
          accessToken: tokens.access_token,
          accessExpiresAt: now + 600_000,
          refreshToken: tokens.refresh_token,
          scope: tokens.scope,
          obtainedAt: now,
        },
      },
    }),
    { mode: 0o600 },
  )
  const added = await cli(['profile', 'add', 'owner', '--server', base, '--auth', 'oauth', '--use'])
  expect(added.code, added.stderr).toBe(0)
}, 300_000)

afterAll(async () => {
  await new Promise<void>((r) => (listener === undefined ? r() : listener.close(() => r())))
  await w?.stop()
  if (home !== '') await rm(home, { recursive: true, force: true })
  for (const database of [importedDb, scratchDb]) {
    if (database !== '') await dropDatabase(pg17, database).catch(() => undefined)
  }
})

describe('the CLI for an external cluster and a legacy import', () => {
  it('A8: writes the bootstrap SQL before registration, which psql runs twice; declaring the tier needs a fresh confirmation', async () => {
    const written = await cli([
      'cluster',
      'bootstrap-sql',
      w.ids.cluster,
      '--database',
      `${importedDb},${scratchDb}`,
      '--project',
      w.ids.project,
      '--ledger',
      'supabase,applied_migrations',
      '--file',
      'bootstrap.sql',
      '--json',
    ])
    expect(written.code, written.stdout + written.stderr).toBe(0)
    expect(json(written).data).toMatchObject({
      pendingDatabases: [importedDb, scratchDb].sort(),
      executionRoles: [{ name: OWNER_ROLE, bypassRlsExcused: false }],
      legacyLedgers: ['applied_migrations', 'supabase'],
    })
    const script = await readFile(join(repo, 'bootstrap.sql'), 'utf8')
    expect(script).not.toMatch(/PASSWORD/)
    for (let i = 0; i < 2; i++) {
      const ran = await runPsql(pg17, shared(script))
      expect(ran.stderr).not.toMatch(/ERROR/)
      expect(ran.status).toBe(0)
    }
    const read = await withSuperuser(pg17, importedDb, async (c) => {
      const r = await c.query(
        `SELECT pg_catalog.has_table_privilege('exponetdb_observer', 'supabase_migrations.schema_migrations', 'SELECT') AS supabase,
                pg_catalog.has_table_privilege('exponetdb_observer', 'public.applied_migrations', 'SELECT') AS runner`,
      )
      return r.rows[0]
    })
    expect(read).toEqual({ supabase: true, runner: true })

    // Registered by the person with the CLI (the worker runs while the CLI waits).
    for (const database of [importedDb, scratchDb]) {
      const registered = await cli(
        // The cluster hosts a production target: the CLI's own confirmation, given with --yes.
        ['cluster', 'database', 'register', w.ids.cluster, database, '--apply', '--yes', '--json'],
        { drive: true },
      )
      expect(registered.code, registered.stdout + registered.stderr).toBe(0)
      expect(json(registered).data).toMatchObject({
        state: 'succeeded',
        verificationOutcome: 'passed',
      })
    }

    const declared = await cli([
      'cluster',
      'declare-tier',
      w.ids.cluster,
      '--tier',
      'prod',
      '--json',
    ])
    expect(declared.code, declared.stdout + declared.stderr).toBe(0)
    expect(json(declared).data).toMatchObject({
      kind: 'registry.cluster.declare_tier',
      subject: { clusterId: w.ids.cluster, tier: 'prod' },
    })
    // --yes is the CLI's own production confirmation; it never replaces the re-authentication.
    const unconfirmed = await cli([
      'plan',
      'apply',
      json(declared).planId,
      '--yes',
      '--no-input',
      '--json',
    ])
    expect([unconfirmed.code, json(unconfirmed).error.code]).toEqual([3, 'REAUTH_REQUIRED'])
  }, 180_000)

  it('A7: the scratch preflight is ready on the prepared targets', async () => {
    paths.imported = await registerTarget('legacy', importedDb)
    paths.scratch = await registerTarget('scratch', scratchDb)
    const checked = await cli([
      'migration',
      'import',
      'scratch-check',
      '--target',
      paths.imported,
      '--scratch',
      paths.scratch,
      '--json',
    ])
    expect(checked.code, checked.stdout + checked.stderr).toBe(0)
    const data = json(checked).data
    expect(data.checks.map((c: { check: string; status: string }) => [c.check, c.status])).toEqual([
      ['scratch_usable', 'pass'],
      ['identity', 'pass'],
      ['empty', 'pass'],
      ['extensions', 'pass'],
      ['outside_scope', 'pass'],
      ['execution_role', 'pass'],
    ])
    expect(data.ready).toBe(true)
  }, 180_000)

  it('A1: analyzes from the project file, reports, resolves and baselines the real-shape history', async () => {
    await writeFile(
      join(repo, 'exponetdb.project.yaml'),
      [
        'schema: exponetdb.project/v1',
        `project: ${w.ids.slug}/platform`,
        'layout: legacy+bundles',
        'executionRoles:',
        `  owner: ${OWNER_ROLE}`,
        'managedScope:',
        '  includeSchemas: [public]',
        '  excludeSchemas: []',
        'lintProfile: standard',
        'bundleRoots:',
        '  - migrations',
        'legacy:',
        '  directory: legacy',
        `  baseline: baseline:${BASELINE}`,
        '',
      ].join('\n'),
    )
    await mkdir(join(repo, 'legacy'))
    await mkdir(join(repo, 'migrations'))
    for (const f of SUPABASE_FILES) await writeFile(join(repo, 'legacy', f.name), f.text)
    await writeFile(
      join(repo, 'hints.yaml'),
      [
        'aliases:',
        ...Object.entries(SUPABASE_ALIASES).map(
          ([name, stems]) => `  ${name}: [${stems.join(', ')}]`,
        ),
        'ledgers: [supabase, applied_migrations]',
        '',
      ].join('\n'),
    )
    const analyzed = await cli([
      'migration',
      'import',
      'analyze',
      '--target',
      paths.imported,
      '--scratch',
      paths.scratch,
      '--hints',
      'hints.yaml',
      '--json',
    ])
    expect(analyzed.code, analyzed.stdout + analyzed.stderr).toBe(0)
    const plan = json(analyzed)
    expect(plan.data).toMatchObject({ kind: 'migration.import.replay', decision: 'allow' })
    const reportId = String(plan.data.change.content.reportId)
    // The project's baseline, given as baseline:<slug> in the project file.
    expect(plan.data.change.content.baselineId).toBe(`baseline:${BASELINE}`)
    const replayed = await cli(['plan', 'apply', plan.planId, '--json'], { drive: true })
    expect(replayed.code, replayed.stdout + replayed.stderr).toBe(0)
    expect(json(replayed).data).toMatchObject({ state: 'succeeded', applyOutcome: 'applied' })

    const reported = await cli([
      'migration',
      'import',
      'report',
      reportId,
      '--target',
      paths.imported,
      '--json',
    ])
    expect(reported.code, reported.stderr).toBe(0)
    const report = json(reported).data
    expect(report.state).toBe('open')
    const item = (id: string) =>
      report.items.find((i: { legacyId: string }) => i.legacyId === id) as
        | { itemId: string; state: string; evidenceStrength: string; evidence: string[] }
        | undefined
    // The ledgers were read through the bootstrap SQL's grant: content evidence, not names.
    expect(item('legacy:0100_accounts')).toMatchObject({
      state: 'recorded_present',
      evidenceStrength: 'medium',
      evidence: expect.arrayContaining(['supabase:statements_normalized']),
    })
    for (const stem of ['0103_notes', '0104_notes_index']) {
      expect(item(`legacy:${stem}`)).toMatchObject({ state: 'recorded_present' })
    }
    expect(item('legacy:0107_settings')).toMatchObject({
      state: 'unrecorded_present',
      evidenceStrength: 'weak',
    })
    const table = await cli(['migration', 'import', 'report', reportId, '--target', paths.imported])
    expect(table.code).toBe(0)
    expect(table.stdout).toContain('0100_accounts')
    expect(table.stdout).not.toContain('\u001b[')

    // A person decides what needs a decision, with a note.
    const open = report.items.filter(
      (i: { decision: unknown; state: string }) =>
        i.decision === null &&
        ['recorded_missing', 'unrecorded_missing', 'ambiguous'].includes(i.state),
    )
    expect(open.length).toBeGreaterThan(0)
    for (const i of open as { itemId: string; legacyId: string }[]) {
      const resolved = await cli([
        'migration',
        'import',
        'resolve',
        reportId,
        String(i.itemId),
        '--target',
        paths.imported,
        '--state',
        i.legacyId.startsWith('drift:') ? 'unrecorded_present' : 'recorded_missing',
        '--note',
        'reviewed by the CLI test',
        '--json',
      ])
      expect(resolved.code, resolved.stdout + resolved.stderr).toBe(0)
    }
    const baselined = await cli(
      [
        'migration',
        'import',
        'baseline',
        reportId,
        '--target',
        paths.imported,
        '--apply',
        '--json',
      ],
      { drive: true },
    )
    expect(baselined.code, baselined.stdout + baselined.stderr).toBe(0)
    expect(json(baselined).data).toMatchObject({
      state: 'succeeded',
      verificationOutcome: 'passed',
    })
    const ledger = await withSuperuser(pg17, importedDb, async (c) => {
      const r = await c.query(
        'SELECT migration_id, checksum_provenance FROM exponetdb.schema_migrations ORDER BY migration_id',
      )
      return new Map(r.rows.map((x) => [String(x.migration_id), String(x.checksum_provenance)]))
    })
    expect(ledger.get('legacy:0100_accounts')).toBe('legacy_applied_statements')
    expect(ledger.get('legacy:0107_settings')).toBe('legacy_file_at_import')
    expect(ledger.get(`baseline:${BASELINE}`)).toBeDefined()
    // Nothing of a token in any output.
    for (const r of [analyzed, replayed, reported, baselined]) {
      expect(r.stdout + r.stderr).not.toMatch(/ex(at|rt)_/)
    }
  }, 300_000)
})
