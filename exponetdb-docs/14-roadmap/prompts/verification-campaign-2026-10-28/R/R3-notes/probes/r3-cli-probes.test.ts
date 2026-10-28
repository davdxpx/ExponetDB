/**
 * Block R, tester R3: reproductions of the first-campaign CLI findings (TC-052, 056, 057, 058, 064,
 * 065, 073, 074 and E9/TC-041) against the CLI source of the tree it is copied into
 * (`apps/cli/test/r3-cli-probes.test.ts`). The CLI runs in process (`run` + `testIo`), the server
 * is a loopback fake that answers `/api/v1/installation` and the canned routes of each probe.
 * Every probe prints one `R3PROBE <name> <json>` line; nothing here asserts a verdict, the verdict
 * is read from the lines. Run: `bunx vitest run test/r3-cli-probes.test.ts` in `apps/cli`.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { run } from '../src/main.ts'
import { TokenStore } from '../src/store.ts'
import { testIo } from './support.ts'

const ACCESS = `exat_${'A'.repeat(43)}`
const REFRESH = `exrt_${'B'.repeat(43)}`

interface Canned {
  readonly status: number
  readonly body: unknown
}
type Handler = (req: IncomingMessage, url: URL, body: string) => Canned | undefined

let server: Server
let origin = ''
let dir = ''
let handler: Handler = () => undefined
const requests: string[] = []

function lintFindings(stdout: string): { rule: string; level: string; blocking: boolean; message: string }[] {
  const doc = JSON.parse(stdout)
  const d = doc.data as Record<string, unknown>
  const found: unknown[] = []
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (v !== null && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (typeof o['rule'] === 'string' && typeof o['blocking'] === 'boolean') found.push(o)
      else Object.values(o).forEach(walk)
    }
  }
  walk(d)
  return found as never
}

function out(name: string, data: unknown): void {
  process.stdout.write(`R3PROBE ${name} ${JSON.stringify(data)}\n`)
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'r3-cli-'))
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks).toString('utf8')
    const url = new URL(req.url ?? '/', origin)
    requests.push(`${req.method} ${url.pathname}${url.search}`)
    const send = (status: number, payload: unknown) =>
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload))
    if (url.pathname === '/api/v1/installation') {
      send(200, {
        version: '0.2.0',
        installationId: 'ins_01M5X2X3ARA75KSKZPANYYEHHW',
        contracts: {
          restApi: 'v1',
          mcpCatalog: 'exponetdb.mcp/v1',
          nodeProtocol: 'exponetdb.node/v1',
          migrationManifest: 'exponetdb.migration/v1',
          projectConfig: 'exponetdb.project/v1',
        },
        features: [],
      })
      return
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      send(200, {
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        revocation_endpoint: `${origin}/oauth/revoke`,
        registration_endpoint: `${origin}/oauth/register`,
        device_authorization_endpoint: `${origin}/oauth/device_authorization`,
        response_types_supported: ['code'],
        response_modes_supported: ['query'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        token_endpoint_auth_signing_alg_values_supported: ['ES256'],
        revocation_endpoint_auth_methods_supported: ['none'],
        revocation_endpoint_auth_signing_alg_values_supported: ['ES256'],
        scopes_supported: ['targets.read'],
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true,
      })
      return
    }
    const canned = handler(req, url, body)
    if (canned !== undefined) return send(canned.status, canned.body)
    send(404, { code: 'NOT_FOUND', title: 'Not found', message: 'No such route in the fake.' })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const address = server.address()
  origin = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
  await new TokenStore(join(dir, 'config')).write({
    server: origin,
    clientId: 'exponetdb-cli',
    accessToken: ACCESS,
    accessExpiresAt: Date.now() + 3_600_000,
    refreshToken: REFRESH,
    scope: 'openid targets.read',
    obtainedAt: Date.now(),
  } as never)
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  await rm(dir, { recursive: true, force: true })
})

async function cli(argv: readonly string[], opts: { cwd?: string; columns?: number } = {}) {
  const stdout: string[] = []
  const stderr: string[] = []
  const before = requests.length
  const code = await run(
    argv,
    testIo({
      configDir: join(dir, 'config'),
      cwd: opts.cwd ?? dir,
      env: { EXPONETDB_URL: origin },
      stdout,
      stderr,
      ...(opts.columns === undefined ? {} : { columns: opts.columns }),
    }),
  )
  return {
    code,
    stdout: stdout.join(''),
    stderr: stderr.join(''),
    requests: requests.slice(before),
  }
}

async function project(name: string): Promise<string> {
  const root = join(dir, name)
  await mkdir(root, { recursive: true })
  const init = await cli(['init', '--project', 'acme/demo'], { cwd: root })
  if (init.code !== 0) throw new Error(`init failed: ${init.stderr}`)
  return root
}

async function bundle(root: string, slug: string, up: string, verify: string, extra: string[] = []) {
  const made = await cli(['migration', 'new', slug, ...extra, '--json'], { cwd: root })
  const data = JSON.parse(made.stdout).data as { path: string; migrationId: string }
  await writeFile(join(data.path, 'up.sql'), up)
  await writeFile(join(data.path, 'verify.sql'), verify)
  return data
}

describe('TC-052: the lint table and the project path', () => {
  it('prints a warn row that blocks', async () => {
    const root = await project('p052')
    await bundle(
      root,
      'leads',
      'CREATE TABLE public.leads (id bigint PRIMARY KEY, email text NOT NULL);\n',
      "-- check: leads exists\nSELECT to_regclass('public.leads') IS NOT NULL AS ok;\n",
    )
    const human = await cli(['migration', 'lint'], { cwd: root })
    out('tc052.lint.human', { code: human.code, stdout: human.stdout, stderr: human.stderr })
    const json = await cli(['migration', 'lint', '--json'], { cwd: root })
    const doc = JSON.parse(json.stdout)
    void doc
    out('tc052.lint.json', lintFindings(json.stdout).map((f) => ({ rule: f.rule, level: f.level, blocking: f.blocking })))
  })

  it('takes a project id only', async () => {
    const r = await cli(['project', 'execution-roles', 'reosa/platform'])
    out('tc052.execution-roles', { code: r.code, stderr: r.stderr.slice(0, 400), requests: r.requests })
    const h = await cli(['project', 'execution-roles', '--help'])
    out('tc052.execution-roles.help', h.stdout.split('\n').filter((l) => /project/i.test(l)).slice(0, 6))
  })
})

describe('TC-056: node plan errors in text mode', () => {
  // The renderer is shared by every command: the error bodies below are the ones the server
  // sends (details as in packages/contracts/src/errors.ts), served for a node read.
  const problems: Record<string, { status: number; body: unknown }> = {
    stale: {
      status: 409,
      body: {
        code: 'NODE_OBSERVATION_STALE',
        title: 'Node observation missing or stale',
        message: 'No node-signed observation of this cluster is recent enough to plan against (at most 10 minutes).',
        remediation: 'Inspect the cluster through the node, then plan again.',
        retryable: false,
        details: { capability: 'postgres.roles.inspect@2' },
      },
    },
    conflict: {
      status: 409,
      body: { code: 'CONFLICT', title: 'Conflict', message: 'The resource changed (If-Match did not match).', retryable: false },
    },
    registry: {
      status: 409,
      body: {
        code: 'REGISTRY_CONFLICT',
        title: 'Registry conflict',
        message: 'The registry state does not allow this change.',
        retryable: false,
        details: { reason: 'ca_bundle_lacks_postgres_ca' },
      },
    },
    validation: {
      status: 400,
      body: { code: 'VALIDATION_FAILED', title: 'Not valid', message: 'The request is not valid.', retryable: false, details: { errors: [{ path: '', message: 'The request is not valid.' }] } },
    },
  }
  it('renders the details of each problem in text', async () => {
    for (const [name, canned] of Object.entries(problems)) {
      handler = (req) => (req.method === 'GET' && req.url?.includes('/nodes/') ? canned : undefined)
      const text = await cli(['node', 'show', 'nod_01M5X2X3ARA75KSKZPANYYEHHW'])
      const json = await cli(['node', 'show', 'nod_01M5X2X3ARA75KSKZPANYYEHHW', '--output', 'json'])
      out(`tc056.${name}`, { text: text.stderr, jsonHasDetails: /details/.test(json.stdout + json.stderr) })
    }
    handler = () => undefined
  })
})

describe('TC-057 / TC-058: node help and job keys', () => {
  it('describes --wait of a plan command', async () => {
    const h = await cli(['node', 'postgres', 'reload', '--help'])
    out('tc057.help', h.stdout.split('\n').filter((l) => /wait|apply/i.test(l)))
  })
  it('refuses job-keys without a change and has no read', async () => {
    const r = await cli(['node', 'job-keys', 'nod_01M5X2X3ARA75KSKZPANYYEHHW'])
    out('tc058.nochange', { code: r.code, stderr: r.stderr, requests: r.requests })
    const h = await cli(['node', 'job-keys', '--help'])
    out('tc058.help', h.stdout.split('\n').filter((l) => /--|Effect|Plan/i.test(l)))
    const s = await cli(['node', 'job-keys', 'nod_01M5X2X3ARA75KSKZPANYYEHHW', '--show'])
    out('tc058.show', { code: s.code, stderr: s.stderr.slice(0, 200) })
  })
})

describe('TC-064: pieces that run without live data', () => {
  it('limits, timeout, error typing', async () => {
    handler = (_req, url) =>
      url.pathname.endsWith('/servers')
        ? { status: 200, body: { items: [{ id: 'srv_01M5X2X3ARA75KSKZPANYYEHHW' }], nextCursor: 'c1' } }
        : undefined
    const l0 = await cli(['server', 'list', '--limit', '0'])
    out('tc064.limit0', { code: l0.code, stderr: l0.stderr.slice(0, 200), requests: l0.requests })
    const lneg = await cli(['server', 'list', '--limit', '-1'])
    out('tc064.limit-1', { code: lneg.code, stderr: lneg.stderr.slice(0, 200), requests: lneg.requests })
    const lbig = await cli(['target', 'list', '--limit', '10001'])
    out('tc064.limit10001', { code: lbig.code, stderr: lbig.stderr.slice(0, 200), requests: lbig.requests })
    handler = () => undefined
    const diff = await cli(['schema', 'diff', 'reosa/platform/staging', 'fingerprint:sha256:abc'])
    out('tc064.schema-diff', { code: diff.code, stderr: diff.stderr.slice(0, 300) })
    const dev = await cli(['dev', 'status'])
    out('tc064.dev', { code: dev.code, stderr: dev.stderr.slice(0, 300) })
    const idents = await cli(['access', 'identities'])
    out('tc064.identities', { code: idents.code, stdout: idents.stdout.slice(0, 200) })
  })
})

describe('TC-065: scratch-reset-sql and presets', () => {
  it('prints the reset script for any nonprod target', async () => {
    handler = (_req, url) => {
      if (url.pathname.includes('/targets/')) {
        return {
          status: 200,
          body: {
            id: 'tgt_01M5J5G1P2QETPENWYHDJ0000A',
            path: 'reosa/platform/staging',
            tier: 'nonprod',
            environment: 'staging',
            projectId: 'prj_01M5J5G1P2QETPENWYHDJ0000B',
            generation: 1,
          },
        }
      }
      if (url.pathname.includes('/projects/')) {
        return {
          status: 200,
          body: { id: 'prj_01M5J5G1P2QETPENWYHDJ0000B', managedScope: { includeSchemas: null, excludeSchemas: null } },
        }
      }
      return undefined
    }
    const r = await cli(['migration', 'import', 'scratch-reset-sql', '--scratch', 'reosa/platform/staging'])
    out('tc065.reset', { code: r.code, head: r.stdout.split('\n').slice(0, 4), stderr: r.stderr.slice(0, 300), requests: r.requests })
    handler = () => undefined
  })
  it('auth presets at 120 columns', async () => {
    const r = await cli(['auth', 'presets'], { columns: 120 })
    out('tc074.presets', { code: r.code, lines: r.stdout.split('\n') })
    const two = await cli(['auth', 'login', '--preset', 'admin', '--preset', 'operator:nonprod', '--no-browser'])
    out('tc074.repeat-preset', { code: two.code, stderr: two.stderr.slice(0, 300) })
  })
})

describe('TC-073: -- covers: numbering, and E9/TC-041: lint filters', () => {
  it('covers 0-based, 1-based and out of range', async () => {
    const root = await project('p073')
    const three =
      "INSERT INTO public.t (a) VALUES (1);\nINSERT INTO public.t (a) VALUES (2);\nINSERT INTO public.t (a) VALUES (3);\n"
    const variants: Record<string, string> = {
      none: '',
      zero: '-- covers: 0\nSELECT true AS ok;\n-- covers: 1\nSELECT true AS ok;\n-- covers: 2\nSELECT true AS ok;\n',
      one: '-- covers: 1\nSELECT true AS ok;\n-- covers: 2\nSELECT true AS ok;\n-- covers: 3\nSELECT true AS ok;\n',
      outofrange: '-- covers: 0, 1, 2, 7\nSELECT true AS ok;\n',
    }
    for (const [name, verify] of Object.entries(variants)) {
      const sub = await project(`p073-${name}`)
      await bundle(sub, 'inserts', three, verify || 'SELECT true AS ok;\n')
      const r = await cli(['migration', 'lint', '--json'], { cwd: sub })
      const findings = lintFindings(r.stdout)
      out(`tc073.${name}`, { code: r.code, findings: findings.map((f) => ({ rule: f.rule, level: f.level, blocking: f.blocking, message: f.message })) })
    }
    void root
  })

  it('lint has no path, bundle or since filter', async () => {
    const root = await project('p041')
    const old = await bundle(
      root,
      'old-definer',
      "CREATE FUNCTION public.f() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;\n",
      "SELECT to_regprocedure('public.f()') IS NOT NULL AS ok;\n",
    )
    const fresh = await bundle(root, 'clean', 'CREATE TABLE public.clean_t (id int);\nGRANT SELECT ON public.clean_t TO PUBLIC;\n', "SELECT to_regclass('public.clean_t') IS NOT NULL AS ok;\n")
    const all = await cli(['migration', 'lint'], { cwd: root })
    out('tc041.all', { code: all.code, tail: all.stdout.split('\n').slice(-6), stderr: all.stderr.slice(0, 200) })
    for (const args of [[fresh.path], ['--bundle', fresh.path], ['--since', old.migrationId], ['--only', fresh.path], ['--help']]) {
      const r = await cli(['migration', 'lint', ...args], { cwd: root })
      out(`tc041.${args.join(' ').replaceAll(root, '.').slice(0, 40)}`, { code: r.code, stderr: r.stderr.slice(0, 160), flags: args[0] === '--help' ? r.stdout.split('\n').filter((l) => /^\s+--/.test(l)) : undefined })
    }
    const ls = await readdir(root)
    out('tc041.root', ls)
  })
})


describe('TC-065 with a stubbed SDK: the reset script is offered for any nonprod target', () => {
  it('runs the command against canned reads', async () => {
    const { COMMANDS } = await import('../src/commands/index.ts')
    const spec = COMMANDS.find((c) => c.path.join(' ') === 'migration import scratch-reset-sql')
    if (spec === undefined) throw new Error('command missing')
    const target = (env: string) => ({ id: 'tgt_01M5J5G1P2QETPENWYHDJ0000A', path: `reosa/platform/${env}`, tier: 'nonprod', projectId: 'prj_01M5J5G1P2QETPENWYHDJ0000B', generation: 1, environment: env })
    for (const env of ['staging', 'scratch', 'ci']) {
      const calls: string[] = []
      const ctx = {
        remote: async () => ({
          context: {},
          sdk: {
            call: async (op: string) => {
              calls.push(op)
              if (op === 'getTarget') return { ok: true, value: target(env) }
              if (op === 'getProject') return { ok: true, value: { managedScope: { includeSchemas: null, excludeSchemas: null } } }
              return { ok: true, value: { installationId: 'ins_01M5X2X3ARA75KSKZPANYYEHHW' } }
            },
          },
        }),
      }
      const r = await spec.run(ctx as never, { args: {}, flags: { scratch: `reosa/platform/${env}` } } as never)
      out(`tc065.stub.${env}`, { status: r.status ?? 'ok', calls, head: (r.blocks[0] as { lines?: string[] } | undefined)?.lines?.slice(0, 2) })
    }
  })
})
