// MCP access token (audience mcp) for the S6 load test: DCR (public client) + authorization code with PKCE; the scripted owner
// consents through human.ts, a one-shot listener on 127.0.0.1:53682 takes the redirect. Prints ids only; the header goes to a 0600 file.
//   node mcp-token.mjs --api http://127.0.0.1:58480 --out FILE
import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync } from 'node:fs'
const a = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => (v.startsWith('--') ? [...acc, [v.slice(2), arr[i + 1]]] : acc), []))
const API = a.api, redirect = 'http://127.0.0.1:53682/callback'
const scopes = ['targets.read', 'schema.read', 'diagnostics.read', 'migrations.read', 'audit.read', 'nodes.read']
const reg = await (await fetch(`${API}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 's6 load client', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: scopes.join(' ') }) })).json()
console.log('client_id:', reg.client_id ? 'registered' : JSON.stringify(reg).slice(0, 200))
if (!reg.client_id) process.exit(1)
const codeP = new Promise((res) => { const s = http.createServer((req, resp) => { const u = new URL(req.url, 'http://x'); resp.end('ok'); res(u.searchParams.get('code')); s.close() }); s.listen(53682, '127.0.0.1') })
const verifier = randomBytes(32).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url')
const url = `${API}/oauth/authorize?` + new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, scope: scopes.join(' '), resource: `${API}/mcp`, state: 's6', code_challenge: challenge, code_challenge_method: 'S256' })
const { stdout: out } = await promisify(execFile)('bash', ['-c', '. /srv/work/s6-infra/s6/lib6.sh; human consent "$1" ' + scopes.join(' '), 'x', url], { encoding: 'utf8' })   // async: the listener above must keep running
console.log('consent:', out.trim().slice(0, 160))
const code = await Promise.race([codeP, new Promise((r) => setTimeout(() => r(null), 15000))])
if (!code) { console.log('no code delivered'); process.exit(1) }
const tok = await (await fetch(`${API}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: reg.client_id, code_verifier: verifier, resource: `${API}/mcp` }) })).json()
console.log('token:', tok.access_token ? `obtained (${(tok.scope ?? '').split(' ').length} scopes, expires_in ${tok.expires_in})` : JSON.stringify(tok).slice(0, 200))
if (tok.access_token) writeFileSync(a.out, `Authorization: Bearer ${tok.access_token}\n`, { mode: 0o600 })
