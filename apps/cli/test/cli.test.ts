import { createHash, randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CliError } from '../src/errors.ts'
import { type Io, run } from '../src/main.ts'
import { discover, liveCredentials, parseServer } from '../src/oauth.ts'
import { TokenStore } from '../src/store.ts'
import { testIo } from './support.ts'

/**
 * The CLI against a fake authorization server on loopback: the browser is
 * simulated by following the authorization URL to the CLI's own loopback
 * listener. Checks state, iss and PKCE handling, the token store's
 * protection, single refresh under concurrency, the device flow's polling
 * and revocation on sign-out.
 */
const token = (prefix: string) => `${prefix}_${randomBytes(32).toString('base64url')}`

interface FakeState {
  issuer?: string
  challenge?: string
  code?: string
  refresh?: string
  refreshCalls: number
  revoked: string[]
  devicePolls: string[]
  lastVerifierOk?: boolean
  /** The scope the server grants (default: targets.read). */
  grant?: string | undefined
  /** The `scope` of each authorization and device request. */
  asked: string[]
  deviceRequests: number
  /** The installation read answers INSUFFICIENT_SCOPE (a refusal while connecting). */
  installationRefused?: boolean
}

let fake: FakeState
let server: Server
let origin = ''
let dir = ''

function send(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

async function body(req: import('node:http').IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

function tokens(scope = 'targets.read') {
  fake.refresh = token('exrt')
  return {
    access_token: token('exat'),
    token_type: 'Bearer',
    expires_in: 600,
    scope,
    refresh_token: fake.refresh,
  }
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin)
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      const issuer = fake.issuer ?? origin
      send(res, 200, {
        issuer,
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
    if (url.pathname === '/oauth/token') {
      const form = await body(req)
      const grant = form.get('grant_type')
      if (form.get('client_id') !== 'exponetdb-cli') {
        send(res, 401, { error: 'invalid_client' })
        return
      }
      if (grant === 'authorization_code') {
        const verifier = form.get('code_verifier') ?? ''
        fake.lastVerifierOk =
          createHash('sha256').update(verifier).digest('base64url') === fake.challenge
        if (form.get('code') !== fake.code || !fake.lastVerifierOk) {
          send(res, 400, { error: 'invalid_grant' })
          return
        }
        send(res, 200, tokens(fake.grant))
        return
      }
      if (grant === 'refresh_token') {
        fake.refreshCalls += 1
        if (form.get('refresh_token') !== fake.refresh) {
          send(res, 400, { error: 'invalid_grant' })
          return
        }
        await new Promise((r) => setTimeout(r, 50))
        send(res, 200, tokens())
        return
      }
      if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
        const next = fake.devicePolls.shift()
        if (next === undefined) {
          send(res, 200, tokens())
          return
        }
        send(res, 400, { error: next })
        return
      }
      send(res, 400, { error: 'unsupported_grant_type' })
      return
    }
    if (url.pathname === '/oauth/revoke') {
      const form = await body(req)
      fake.revoked.push(form.get('token') ?? '')
      res.writeHead(200).end()
      return
    }
    if (url.pathname === '/oauth/device_authorization') {
      fake.deviceRequests += 1
      fake.asked.push((await body(req)).get('scope') ?? '')
      send(res, 200, {
        device_code: token('exdc'),
        user_code: 'BCDF-GHJK',
        verification_uri: `${origin}/oauth/device`,
        expires_in: 600,
        interval: 5,
      })
      return
    }
    if (url.pathname === '/api/v1/installation') {
      const auth = req.headers.authorization ?? ''
      if (!/^Bearer exat_/.test(auth)) {
        send(res, 401, { code: 'UNAUTHENTICATED' })
        return
      }
      if (fake.installationRefused === true) {
        send(res, 403, { code: 'INSUFFICIENT_SCOPE', details: { requiredScope: 'targets.read' } })
        return
      }
      send(res, 200, {
        version: '0.2.0',
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
    if (url.pathname.startsWith('/api/v1/')) {
      send(res, 403, {
        code: 'INSUFFICIENT_SCOPE',
        title: 'Insufficient scope',
        message: 'The token lacks the scope this action needs.',
        retryable: false,
        details: { requiredScope: 'migrations.plan' },
      })
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  origin = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(async () => {
  fake = { refreshCalls: 0, revoked: [], devicePolls: [], asked: [], deviceRequests: 0 }
  dir = await mkdtemp(join(tmpdir(), 'exdb-cli-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A browser that follows the authorization URL straight to the redirect, with what the test chooses. */
function browser(answer: (authorize: URL) => Record<string, string>) {
  return (url: string) => {
    const authorize = new URL(url)
    fake.asked.push(authorize.searchParams.get('scope') ?? '')
    const challenge = authorize.searchParams.get('code_challenge')
    if (challenge !== null) fake.challenge = challenge
    fake.code = token('exac')
    const redirect = new URL(authorize.searchParams.get('redirect_uri') ?? '')
    const params = answer(authorize)
    for (const [k, v] of Object.entries(params)) redirect.searchParams.set(k, v)
    page = fetch(redirect).then(async (r) => ({
      status: r.status,
      text: await r.text(),
      csp: r.headers.get('content-security-policy'),
    }))
  }
}
let page: Promise<{ status: number; text: string; csp: string | null }> | undefined

function io(openBrowser: (url: string) => void, lines: string[] = []): Io {
  return testIo({
    lines,
    env: { EXPONETDB_URL: origin },
    configDir: join(dir, 'config'),
    openBrowser,
  })
}

const happy = browser((a) => ({
  code: fake.code ?? '',
  state: a.searchParams.get('state') ?? '',
  iss: origin,
}))

describe('loopback sign-in', () => {
  it('signs in with PKCE S256, stores the tokens privately and signs out with revocation', async () => {
    const lines: string[] = []
    expect(await run(['login'], io(happy, lines))).toBe(0)
    expect(fake.lastVerifierOk).toBe(true)
    expect(await page).toMatchObject({ status: 200, csp: "default-src 'none'" })
    const store = new TokenStore(join(dir, 'config'))
    const saved = await store.read(origin)
    expect(saved?.accessToken).toMatch(/^exat_/)
    expect(((await stat(store.path)).mode & 0o777).toString(8)).toBe('600')
    expect(((await stat(store.dir)).mode & 0o777).toString(8)).toBe('700')
    expect((await readdir(store.dir)).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(lines.join('\n')).not.toMatch(/ex(at|rt|ac)_/)

    expect(await run(['whoami'], io(happy, lines))).toBe(0)
    expect(lines.join('\n')).toMatch(/Version:\s+0\.2\.0/)

    const refresh = saved?.refreshToken
    expect(await run(['logout'], io(happy, lines))).toBe(0)
    expect(fake.revoked).toEqual([refresh])
    expect(await store.read(origin)).toBeUndefined()
  })

  it('refuses a response with the wrong state, the wrong issuer or an error, and reflects nothing', async () => {
    for (const answer of [
      () => ({ code: fake.code ?? '', state: 'forged', iss: origin, x: '<script>' }),
      (a: URL) => ({
        code: fake.code ?? '',
        state: a.searchParams.get('state') ?? '',
        iss: 'https://evil.example.test',
      }),
      (a: URL) => ({
        error: 'access_denied',
        state: a.searchParams.get('state') ?? '',
        iss: origin,
      }),
    ]) {
      const lines: string[] = []
      expect(await run(['login'], io(browser(answer), lines))).toBe(1)
      const shown = await page
      expect(shown?.status).toBe(400)
      expect(shown?.text).not.toContain('script')
      expect(shown?.text).not.toContain('forged')
      expect(await new TokenStore(join(dir, 'config')).read(origin)).toBeUndefined()
    }
  })

  it('refuses a server whose metadata names another issuer', async () => {
    fake.issuer = 'https://other.example.test'
    expect(
      await discover(fetch, origin).catch((e: unknown) => (e instanceof CliError ? e.code : e)),
    ).toBe('discovery_failed')
  })

  it('accepts only https servers, or http on loopback', () => {
    expect(parseServer('https://db.example.test/')).toBe('https://db.example.test')
    for (const bad of [
      'https://a$(id).evil.example.test',
      'https://a`id`.evil.example.test',
      'https://a;id.evil.example.test',
      "https://a'b.evil.example.test",
      'http://db.example.test',
      'https://db.example.test/api',
      'https://u:p@db.example.test',
      'ftp://x',
    ]) {
      expect(() => parseServer(bad), bad).toThrow(CliError)
    }
  })
})

describe('token store', () => {
  it('refuses a credentials file that others can read', async () => {
    expect(await run(['login'], io(happy))).toBe(0)
    const store = new TokenStore(join(dir, 'config'))
    await chmod(store.path, 0o644)
    const error = await store.read(origin).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CliError)
    expect(error instanceof CliError && error.code).toBe('store_insecure')
    expect(error instanceof Error ? error.message : '').not.toMatch(/ex(at|rt)_/)
  })

  it('ignores entries that are not valid credentials', async () => {
    const store = new TokenStore(join(dir, 'config'))
    await store.withLock(async () => undefined)
    await writeFile(
      store.path,
      JSON.stringify({
        version: 1,
        credentials: { [origin]: { server: origin, accessToken: 'x' } },
      }),
      {
        mode: 0o600,
      },
    )
    expect(await store.read(origin)).toBeUndefined()
  })

  it('refreshes once when two processes need a new access token at the same time', async () => {
    expect(await run(['login'], io(happy))).toBe(0)
    const store = new TokenStore(join(dir, 'config'))
    const saved = await store.read(origin)
    if (saved === undefined) throw new Error('saved')
    await store.withLock(() => store.write({ ...saved, accessExpiresAt: Date.now() - 1 }))
    const server = await discover(fetch, origin)
    const other = new TokenStore(join(dir, 'config'))
    const [a, b] = await Promise.all([
      liveCredentials(fetch, store, server),
      liveCredentials(fetch, other, server),
    ])
    expect(fake.refreshCalls).toBe(1)
    expect(a.accessToken).toBe(b.accessToken)
    expect(a.refreshToken).toBe(fake.refresh)
  })
})

describe('device sign-in', () => {
  it('polls at the interval, slows down when told and stores the tokens', async () => {
    fake.devicePolls = ['authorization_pending', 'slow_down', 'authorization_pending']
    const lines: string[] = []
    const sleeps: number[] = []
    const { deviceLogin } = await import('../src/oauth.ts')
    const credentials = await deviceLogin(fetch, await discover(fetch, origin), {
      scopes: ['targets.read'],
      present: async (uri, code) => {
        lines.push(uri, code)
      },
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    expect(credentials.accessToken).toMatch(/^exat_/)
    expect(lines).toEqual([`${origin}/oauth/device`, 'BCDF-GHJK'])
    expect(sleeps).toEqual([5000, 5000, 10000, 10000])
  })

  it('stops on a denial', async () => {
    fake.devicePolls = ['access_denied']
    const { deviceLogin } = await import('../src/oauth.ts')
    const error = await deviceLogin(fetch, await discover(fetch, origin), {
      scopes: ['targets.read'],
      present: async () => undefined,
      sleep: async () => undefined,
    }).catch((e: unknown) => e)
    expect(error instanceof CliError && error.code).toBe('oauth_access_denied')
  })
})

describe('scope presets and the remembered request', () => {
  const config = () => join(dir, 'config')
  const profileFile = async () =>
    JSON.parse(await readFile(join(config(), 'profiles.json'), 'utf8')) as {
      profiles: Record<string, { auth: Record<string, unknown> }>
    }
  const addProfile = (extra: string[] = []) =>
    run(['profile', 'add', 'lab', '--server', origin, '--use', ...extra], io(happy))
  const ioNoEnv = (lines: string[] = []) =>
    testIo({ lines, configDir: config(), openBrowser: happy })

  it('asks for a preset, remembers the grant per profile and asks for it again', async () => {
    expect(await addProfile()).toBe(0)
    fake.grant = 'targets.read schema.read migrations.plan'
    const lines: string[] = []
    expect(await run(['login', '--preset', 'developer:nonprod'], ioNoEnv(lines))).toBe(0)
    expect(fake.asked.at(-1)?.split(' ')).toEqual([
      'targets.read',
      'schema.read',
      'migrations.read',
      'diagnostics.read',
      'backups.read',
      'nodes.read',
      'audit.read',
      'migrations.plan',
      'migrations.apply:nonprod',
    ])
    expect(lines.join('\n')).toMatch(/Not granted: migrations\.read .*migrations\.apply:nonprod/)
    const auth = (await profileFile()).profiles['lab']?.auth
    expect(auth?.['scopes']).toEqual(['targets.read', 'schema.read', 'migrations.plan'])
    expect(auth?.['requestedScopes']).toHaveLength(9)

    fake.grant = undefined
    expect(await run(['login'], ioNoEnv())).toBe(0)
    expect(fake.asked.at(-1)).toBe('targets.read schema.read migrations.plan')
  })

  it('never remembers a production scope, and keeps the installation id', async () => {
    expect(await addProfile()).toBe(0)
    expect(await run(['login'], ioNoEnv())).toBe(0)
    expect(await run(['whoami'], ioNoEnv())).toBe(0)
    const seen = (await profileFile()).profiles['lab'] as unknown as { installationId: unknown }
    fake.grant = 'targets.read migrations.apply:prod'
    const lines: string[] = []
    expect(await run(['login', '--preset', 'developer:prod'], ioNoEnv(lines))).toBe(0)
    expect(lines.join('\n')).toMatch(/asks for the same without the production scopes/)
    const after = (await profileFile()).profiles['lab'] as unknown as {
      installationId: unknown
      auth: Record<string, unknown>
    }
    expect(after.auth['scopes']).toEqual(['targets.read'])
    expect(after.installationId).toEqual(seen.installationId)
    expect(await run(['login'], ioNoEnv())).toBe(0)
    expect(fake.asked.at(-1)).toBe('targets.read')
  })

  it('does not rewrite a profile that changed while the browser was open', async () => {
    expect(await addProfile()).toBe(0)
    const path = join(config(), 'profiles.json')
    const changed = {
      version: 1,
      current: 'lab',
      profiles: {
        lab: {
          server: origin,
          installationId: null,
          auth: { method: 'api-key', keyFile: '/tmp/key' },
          defaults: {},
        },
      },
    }
    const lines: string[] = []
    const browserThenChange = (url: string) => {
      writeFileSync(path, JSON.stringify(changed), { mode: 0o600 })
      happy(url)
    }
    expect(
      await run(
        ['login', '--preset', 'read'],
        testIo({ lines, configDir: config(), openBrowser: browserThenChange }),
      ),
    ).toBe(0)
    expect(lines.join('\n')).toMatch(/Not remembered: the profile lab changed/)
    expect((await profileFile()).profiles['lab']?.auth).toEqual({
      method: 'api-key',
      keyFile: '/tmp/key',
    })
  })

  it('without a profile asks again for the current sign-in, and drops what it does not know', async () => {
    fake.grant = 'targets.read schema.read'
    expect(await run(['login', '--preset', 'read'], io(happy))).toBe(0)
    expect(await run(['login'], io(happy))).toBe(0)
    expect(fake.asked.at(-1)).toBe('targets.read schema.read')

    expect(await addProfile()).toBe(0)
    const path = join(config(), 'profiles.json')
    const file = JSON.parse(await readFile(path, 'utf8'))
    file.profiles.lab.auth = {
      method: 'oauth',
      scopes: ['schema.read', 'plans.approve', 'x\u001b[2J'],
    }
    await writeFile(path, JSON.stringify(file), { mode: 0o600 })
    const lines: string[] = []
    expect(await run(['login'], ioNoEnv(lines))).toBe(0)
    expect(fake.asked.at(-1)).toBe('schema.read')
    expect(lines.join('\n')).toContain(
      'Not asked for (unknown to this CLI): ["plans.approve","x\\u001b[2J"]',
    )
    expect(lines.join('\n')).not.toContain('\u001b')
  })

  it('combines --preset and --scope, and an oauth profile may name the first request', async () => {
    expect(await addProfile(['--scopes', 'targets.read,registry.manage'])).toBe(0)
    expect(await run(['login'], ioNoEnv())).toBe(0)
    expect(fake.asked.at(-1)).toBe('targets.read registry.manage')
    expect(
      await run(['login', '--preset', 'read', '--scope', 'migrations.import'], ioNoEnv()),
    ).toBe(0)
    expect(fake.asked.at(-1)?.split(' ')).toEqual([
      ...'targets.read schema.read migrations.read diagnostics.read backups.read nodes.read audit.read'.split(
        ' ',
      ),
      'migrations.import',
    ])
    expect(await addProfile(['--force', '--scopes', 'plans.approve'])).toBe(2)
  })

  it('refuses an unknown preset as a usage error', async () => {
    expect(await run(['login', '--preset', 'everything'], io(happy))).toBe(2)
    expect(fake.asked).toEqual([])
  })

  it('never sends an admin or production preset, or such a remembered request, through the device flow', async () => {
    for (const preset of ['admin', 'developer:prod', 'operator:prod']) {
      const lines: string[] = []
      expect(await run(['login', '--device', '--preset', preset], io(happy, lines))).toBe(2)
      expect(lines.join('\n')).toMatch(/device flow never carries/)
    }
    expect(await addProfile(['--scopes', 'targets.read,registry.manage'])).toBe(0)
    const lines: string[] = []
    expect(await run(['login', '--device'], ioNoEnv(lines))).toBe(2)
    expect(lines.join('\n')).toMatch(/registry\.manage \(remembered for profile lab\)/)
    expect(fake.deviceRequests).toBe(0)

    expect(await run(['login', '--device', '--preset', 'developer:nonprod'], ioNoEnv())).toBe(0)
    expect(fake.deviceRequests).toBe(1)
    expect(fake.asked.at(-1)).toContain('migrations.apply:nonprod')
  })

  it('names the sign-in that would allow a command refused for a missing scope', async () => {
    expect(await run(['login'], io(happy))).toBe(0)
    const stdout: string[] = []
    const code = await run(
      ['target', 'list', '--output', 'json'],
      testIo({ stdout, env: { EXPONETDB_URL: origin }, configDir: config() }),
    )
    expect(code).toBe(3)
    const doc = JSON.parse(stdout.join('')) as { error: { code: string }; next: string[] }
    expect(doc.error.code).toBe('INSUFFICIENT_SCOPE')
    expect(doc.next).toEqual([
      `exponetdb login --server ${origin} --preset developer:nonprod`,
      `exponetdb login --server ${origin} --scope "targets.read migrations.plan"`,
    ])
  })

  it('keeps the granted scopes in the hint when the refusal comes while connecting', async () => {
    fake.grant = 'schema.read migrations.plan'
    expect(await run(['login'], io(happy))).toBe(0)
    fake.installationRefused = true
    const stdout: string[] = []
    const code = await run(
      ['whoami', '--output', 'json'],
      testIo({ stdout, env: { EXPONETDB_URL: origin }, configDir: config() }),
    )
    expect(code).toBe(3)
    expect((JSON.parse(stdout.join('')) as { next: string[] }).next).toEqual([
      `exponetdb login --server ${origin} --preset developer:nonprod`,
      `exponetdb login --server ${origin} --scope "schema.read migrations.plan targets.read"`,
    ])
  })

  it('reports the scopes, what was not granted and the next preset in doctor', async () => {
    expect(await addProfile(['--scopes', 'targets.read,registry.manage'])).toBe(0)
    expect(await run(['login'], ioNoEnv())).toBe(0)
    const stdout: string[] = []
    await run(
      ['doctor', '--skip-parser', '--output', 'json'],
      testIo({ stdout, configDir: config() }),
    )
    const checks = (
      JSON.parse(stdout.join('')) as {
        data: { items: { check: string; status: string; detail: string }[] }
      }
    ).data.items
    const byName = (name: string) => checks.find((c) => c.check === name)
    expect(byName('scopes')).toMatchObject({
      status: 'ok',
      detail: 'targets.read; presets covered: none',
    })
    expect(byName('scopes not granted')).toMatchObject({ status: 'warn' })
    expect(byName('scopes not granted')?.detail).toMatch(/^registry\.manage /)
    // The suggestion keeps the scope held now (a sign-in replaces the grant).
    expect(byName('more scopes')?.detail).toMatch(
      /^read adds schema\.read .*: exponetdb login --server \S+ --scope "targets\.read schema\.read /,
    )
  })

  it('shows the granted scopes against the presets in whoami', async () => {
    expect(await addProfile(['--scopes', 'targets.read,registry.manage'])).toBe(0)
    expect(await run(['login'], ioNoEnv())).toBe(0)
    const stdout: string[] = []
    expect(await run(['whoami', '--output', 'json'], testIo({ stdout, configDir: config() }))).toBe(
      0,
    )
    const doc = JSON.parse(stdout.join('')) as {
      data: {
        scopes: {
          granted: string[]
          notGranted: string[]
          presets: { preset: string; covered: boolean; missing: string[] }[]
        }
      }
    }
    expect(doc.data.scopes.granted).toEqual(['targets.read'])
    expect(doc.data.scopes.notGranted).toEqual(['registry.manage'])
    expect(doc.data.scopes.presets.find((p) => p.preset === 'read')?.missing).toContain(
      'schema.read',
    )
  })
})
