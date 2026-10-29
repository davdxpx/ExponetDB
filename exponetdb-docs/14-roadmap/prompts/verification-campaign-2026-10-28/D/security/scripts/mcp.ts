/**
 * S4: a minimal MCP client of the disposable stack (OAuth authorization-code flow with PKCE, a person's consent,
 * then JSON-RPC over the streamable HTTP endpoint). Never prints a token; results go to $L4/mcp/<name>.json (0600).
 *
 *   bun --conditions=@exponetdb/source s4/mcp.ts register [name]                       DCR; writes $S4/mcp/client.json
 *   EXSTACK_OWNER_FILE=<person>.json bun ... s4/mcp.ts login [--targets t1,t2] [--tiers a,b] [scope...]
 *                                                                                      consent as that person, writes $S4/mcp/token.json and $S4/creds/mcp-client.token
 *   bun ... s4/mcp.ts tools                                                            tools/list -> $L4/mcp/tools.json (names printed)
 *   bun ... s4/mcp.ts call <name> <tool> [json args | @file]                           tools/call; prints isError and top-level keys
 *   bun ... s4/mcp.ts raw <name> <json-rpc body>                                       any JSON-RPC message
 *   env MCP_TOKEN_FILE overrides the token file (default $S4/mcp/token.json)
 */
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { Human, must } from '../human.ts'

const S4 = process.env['S4'] ?? '/srv/work/s4'
const L4 = process.env['L4'] ?? '/srv/work/logs-s4'
const BASE = process.env['EXSTACK_PUBLIC_URL'] ?? 'http://localhost:58480'
const REDIRECT = 'http://127.0.0.1:34999/callback'
mkdirSync(`${S4}/mcp`, { recursive: true, mode: 0o700 })
mkdirSync(`${L4}/mcp`, { recursive: true, mode: 0o700 })
const tokenFile = process.env['MCP_TOKEN_FILE'] ?? `${S4}/mcp/token.json`
const b64u = (b: Buffer) => b.toString('base64url')

async function register(name: string): Promise<void> {
  const r = await fetch(`${BASE}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  })
  const body = (await r.json()) as Record<string, unknown>
  writeFileSync(`${S4}/mcp/client.json`, JSON.stringify(body), { mode: 0o600 })
  console.log(JSON.stringify({ status: r.status, client_id: body['client_id'], error: body['error'] }))
}

async function login(args: string[]): Promise<void> {
  const client = JSON.parse(readFileSync(`${S4}/mcp/client.json`, 'utf8')) as { client_id: string }
  let targets: string | undefined
  let tiers: string | undefined
  const scopes: string[] = []
  while (args.length > 0) {
    const a = args.shift() as string
    if (a === '--targets') targets = args.shift()
    else if (a === '--tiers') tiers = args.shift()
    else scopes.push(a)
  }
  const verifier = b64u(randomBytes(32))
  const challenge = b64u(createHash('sha256').update(verifier).digest())
  const state = b64u(randomBytes(12))
  const u = new URL(`${BASE}/oauth/authorize`)
  u.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    scope: scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${BASE}/mcp`,
  }).toString()
  const human = Human.load()
  await human.signIn()
  const started = await human.call('GET', `${u.pathname}${u.search}`)
  if (started.status !== 302 || started.location === null) throw new Error(`authorize: HTTP ${started.status} ${String(started.body?.code ?? started.body?.error ?? '')}`)
  const handle = started.location.slice(started.location.indexOf('#request=') + '#request='.length)
  const t = tiers === undefined ? ['nonprod'] : tiers.split(',')
  if (t.includes('prod')) await human.reauth()
  const decided = await human.call('POST', '/auth/oauth/consent', {
    request: handle,
    decision: 'allow',
    scopes,
    tiers: t,
    lifetimeDays: 30,
    ...(t.includes('prod') ? { acknowledgeProduction: true } : {}),
    ...(targets === undefined ? {} : { targets: { kind: 'list', targetIds: targets.split(',') } }),
  })
  must(decided, 200, 'consent')
  const code = new URL(String(decided.body.redirectTo)).searchParams.get('code')
  if (code === null) throw new Error('no code in the redirect')
  const tok = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: client.client_id,
      code_verifier: verifier,
      resource: `${BASE}/mcp`,
    }),
  })
  const body = (await tok.json()) as Record<string, unknown>
  writeFileSync(tokenFile, JSON.stringify(body), { mode: 0o600 })
  if (typeof body['access_token'] === 'string') {
    writeFileSync(`${S4}/creds/mcp-client.token`, `${body['access_token']}\n`, { mode: 0o600 })
    chmodSync(`${S4}/creds/mcp-client.token`, 0o600)
  }
  console.log(JSON.stringify({ token: tok.status, scope: body['scope'], expires_in: body['expires_in'], error: body['error'], tiers: t, targets: targets?.split(',').length ?? 'all' }))
}

let rpcId = 1
async function rpc(body: unknown, session?: string): Promise<{ status: number; json: any; session: string | null; text: string }> {
  const tok = JSON.parse(readFileSync(tokenFile, 'utf8')) as { access_token: string }
  const headers: Record<string, string> = {
    authorization: `Bearer ${tok.access_token}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-06-18',
  }
  if (session !== undefined) headers['mcp-session-id'] = session
  const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await r.text()
  let json: any
  const ct = r.headers.get('content-type') ?? ''
  try {
    if (ct.includes('text/event-stream')) {
      const data = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
      json = data.length > 0 ? JSON.parse(data[data.length - 1] as string) : undefined
    } else json = text.length === 0 ? undefined : JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: r.status, json, session: r.headers.get('mcp-session-id'), text }
}

async function init(): Promise<string | undefined> {
  const r = await rpc({ jsonrpc: '2.0', id: rpcId++, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 's4', version: '1' } } })
  if (r.status !== 200) throw new Error(`initialize: HTTP ${r.status} ${r.text.slice(0, 200)}`)
  const s = r.session ?? undefined
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, s)
  return s
}

async function main(): Promise<void> {
  const [cmd, ...a] = process.argv.slice(2)
  if (cmd === 'register') return register(a[0] ?? 's4-mcp-client')
  if (cmd === 'login') return login(a)
  const s = await init()
  if (cmd === 'tools') {
    const r = await rpc({ jsonrpc: '2.0', id: rpcId++, method: 'tools/list', params: {} }, s)
    writeFileSync(`${L4}/mcp/tools.json`, JSON.stringify(r.json), { mode: 0o600 })
    console.log(JSON.stringify({ status: r.status, tools: (r.json?.result?.tools ?? []).map((t: { name: string }) => t.name) }))
  } else if (cmd === 'call') {
    const [name, tool, argsRaw] = a
    const args = argsRaw === undefined ? {} : JSON.parse(argsRaw.startsWith('@') ? readFileSync(argsRaw.slice(1), 'utf8') : argsRaw)
    const r = await rpc({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: tool, arguments: args } }, s)
    writeFileSync(`${L4}/mcp/${name}.json`, JSON.stringify({ status: r.status, body: r.json ?? r.text }), { mode: 0o600 })
    const res = r.json?.result
    const err = r.json?.error
    console.log(JSON.stringify({ name, status: r.status, isError: res?.isError ?? null, keys: Object.keys(res?.structuredContent ?? {}), code: res?.structuredContent?.code ?? err?.data?.code ?? err?.code ?? null }))
  } else if (cmd === 'raw') {
    const [name, bodyArg] = a
    const r = await rpc(JSON.parse(bodyArg as string), s)
    writeFileSync(`${L4}/mcp/${name}.json`, JSON.stringify({ status: r.status, body: r.json ?? r.text }), { mode: 0o600 })
    console.log(JSON.stringify({ name, status: r.status, keys: Object.keys(r.json ?? {}) }))
  } else throw new Error('register | login | tools | call | raw')
}
main().catch((e: unknown) => {
  console.error(String(e instanceof Error ? e.message : e).slice(0, 300))
  process.exit(1)
})
if (existsSync('/nonexistent')) console.log('')
