/**
 * Authorization matrix harness (verification campaign 2026-10-28, block D).
 * NOT RUN in the campaign's static pass: it needs a running disposable stack.
 *
 *   bun run-matrix.ts --base http://10.0.0.5:8443 --creds ./creds --fixtures ./fixtures.json \
 *       [--matrix authz-matrix.json] [--samples authz-samples.json] [--bodies bodies.json] \
 *       [--only rest|mcp] [--allow-mutations] [--out results] [--self-test]
 *
 * It NEVER talks to anything but a loopback or RFC 1918 address (see assertLocalBase):
 * a public host name, a public address, a link-local address, an address with
 * credentials in the URL, and a redirect are all refused. Secrets: one file per
 * credential class in --creds (`<class>.token`, one line, never printed or stored);
 * the output holds status codes and error codes only.
 *
 * For every REST row x credential class x tier variant it sends a valid-shaped request
 * (authz-samples.json) and compares the observed class with the expected one
 * (authz-matrix.json `exp`):  A = authorization passed (2xx, or a domain refusal such as
 * 404/409/422 that is not an authorization code), D = authorization refused (401/403, a
 * concealed TARGET_NOT_FOUND, REAUTH_REQUIRED ...), V = 400 VALIDATION_FAILED (the sample
 * was not valid-shaped: validation runs BEFORE authorization at the HTTP layer, so a 400
 * proves nothing; fix the sample in bodies.json), X = 5xx (a defect by itself).
 * Existence oracle: where fixtures.foreign.<param> names a real object the credential may
 * not see, the answer for it must equal the answer for a fabricated id (same status,
 * same code).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ------------------------------------------------------------ the local-only guard
const PRIVATE_V4: readonly RegExp[] = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./]

/** Throws unless the URL is http(s) to localhost, 127/8, ::1 or an RFC 1918 IPv4 literal, without credentials. */
export function assertLocalBase(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('refused: the base URL does not parse')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('refused: http or https only')
  if (url.username !== '' || url.password !== '') throw new Error('refused: no credentials in the URL')
  const host = url.hostname.toLowerCase()
  const ok =
    host === 'localhost' ||
    host === '[::1]' ||
    (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && PRIVATE_V4.some((re) => re.test(host)))
  if (!ok || /exponet/.test(host)) {
    throw new Error(`refused: ${host} is not localhost, 127/8, ::1 or an RFC 1918 address; this harness must never reach a real installation`)
  }
  return url
}

// ------------------------------------------------------------ arguments
const argv = process.argv.slice(2)
const flag = (n: string) => argv.includes(n)
const opt = (n: string): string | undefined => {
  const i = argv.indexOf(n)
  return i < 0 ? undefined : argv[i + 1]
}

if (flag('--self-test')) {
  const bad = ['https://db.exponetdb.cloud', 'https://db.exponet.cloud/x', 'http://1.2.3.4', 'http://169.254.169.254', 'http://172.32.0.1', 'http://[2001:db8::1]', 'http://user:pw@127.0.0.1', 'http://example.com', 'ftp://127.0.0.1', 'http://127.0.0.1.evil.test']
  const good = ['http://127.0.0.1:8080', 'http://localhost:3000', 'http://10.1.2.3', 'http://172.16.0.9:443', 'https://192.168.1.2', 'http://[::1]:8080']
  for (const u of bad) {
    let refused = false
    try { assertLocalBase(u) } catch { refused = true }
    if (!refused) throw new Error(`self-test: ${u} must be refused`)
  }
  for (const u of good) assertLocalBase(u)
  console.log(`self-test ok: ${bad.length} refused, ${good.length} accepted`)
  process.exit(0)
}

const baseRaw = opt('--base')
if (baseRaw === undefined) {
  console.error('usage: bun run-matrix.ts --base http://127.0.0.1:PORT --creds DIR --fixtures FILE [--allow-mutations] [--only rest|mcp] [--out PREFIX]')
  process.exit(2)
}
let base: URL
try {
  base = assertLocalBase(baseRaw)
} catch (error) {
  console.error((error as Error).message)
  process.exit(3)
}
const here = new URL('.', import.meta.url).pathname
const matrix = JSON.parse(readFileSync(opt('--matrix') ?? join(here, 'authz-matrix.json'), 'utf8'))
const samples = JSON.parse(readFileSync(opt('--samples') ?? join(here, 'authz-samples.json'), 'utf8'))
const fixtures = JSON.parse(readFileSync(opt('--fixtures') ?? 'fixtures.json', 'utf8')) as {
  targets: { nonprod: string; prod: string }
  ids?: Record<string, string>
  foreign?: Record<string, string>
}
const bodies: Record<string, unknown> = existsSync(opt('--bodies') ?? 'bodies.json') ? JSON.parse(readFileSync(opt('--bodies') ?? 'bodies.json', 'utf8')) : {}
const credsDir = opt('--creds') ?? 'creds'
const allowMutations = flag('--allow-mutations')
const only = opt('--only')
const outPrefix = opt('--out') ?? 'results'

const CLASSES = Object.keys(matrix.credentialClasses) as string[]
const tokens = new Map<string, string>()
for (const c of CLASSES) {
  const f = join(credsDir, `${c}.token`)
  if (existsSync(f)) tokens.set(c, readFileSync(f, 'utf8').split('\n')[0]!.trim())
}

// ------------------------------------------------------------ helpers
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
function fakeId(prefix: string): string {
  let s = '0'
  for (let i = 0; i < 25; i++) s += ULID_ALPHABET[Math.floor(Math.random() * 32)]
  return prefix === 'ulid' ? s : `${prefix}_${s}`
}
function fill(value: unknown, key: string, variant: 'nonprod' | 'prod' | 'none', foreign: boolean): unknown {
  if (typeof value === 'string' && value.startsWith('@id:')) {
    const prefix = value.slice(4)
    if (prefix === 'tgt') return variant === 'prod' ? fixtures.targets.prod : fixtures.targets.nonprod
    const fx = foreign ? fixtures.foreign?.[key] : (fixtures.ids?.[key] ?? fixtures.ids?.[prefix])
    return fx ?? fakeId(prefix)
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, key, variant, foreign))
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, k, variant, foreign)]))
  return value
}
const DENY_CODES = new Set(['UNAUTHENTICATED', 'TOKEN_EXPIRED', 'GRANT_REVOKED', 'INSUFFICIENT_SCOPE', 'PERMISSION_DENIED', 'TARGET_NOT_FOUND', 'TARGET_NOT_IN_GRANT', 'TIER_NOT_PERMITTED', 'REAUTH_REQUIRED', 'HUMAN_APPLY_REQUIRED', 'RECOVERY_REQUIRED', 'POLICY_DENIED'])

type Observed = 'A' | 'D' | 'V' | 'X' | 'R'
interface Answer { status: number; code: string | null; obs: Observed }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let sent = 0

async function call(method: string, path: string, token: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Answer> {
  const url = new URL(path, base)
  assertLocalBase(url.origin) // every request is re-checked
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json', ...extraHeaders }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(url, { method, headers, redirect: 'manual', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  sent++
  if (res.status >= 300 && res.status < 400) throw new Error('refused: the server answered a redirect; the harness never follows one')
  let code: string | null = null
  try { code = ((await res.json()) as { code?: string }).code ?? null } catch { /* no body */ }
  return { status: res.status, code, obs: classify(res.status, code) }
}
function classify(status: number, code: string | null): Observed {
  if (status === 429) return 'R'
  if (status >= 500) return 'X'
  if (status === 400 && code === 'VALIDATION_FAILED') return 'V'
  if (status === 401 || status === 403 || (code !== null && DENY_CODES.has(code))) return 'D'
  return 'A'
}

// ------------------------------------------------------------ the run
interface Result { row: string; cls: string; variant: string; exp: string; obs: string; status: number; code: string | null; verdict: string }
const results: Result[] = []
const notRun: string[] = []

if (only !== 'mcp') {
  for (const row of matrix.rows as any[]) {
    for (const r of (row.rest ?? []) as any[]) { // S4 patch: rows without a REST binding (MCP-only actions) have no rest key
      const sample = samples.rest[r.op]
      if (sample === undefined || sample.body === 'raw' || sample.params === null || sample.query === null || sample.body === null) {
        if (bodies[r.op] === undefined) { notRun.push(`${r.op}: no valid-shaped sample (supply bodies.json)`); continue }
      }
      const variants: ('nonprod' | 'prod' | 'none')[] = row.exp.owner.length === 2 ? ['nonprod', 'prod'] : ['none']
      for (const cls of CLASSES) {
        const def = matrix.credentialClasses[cls]
        if (def.client === 'mcp') continue
        const token = tokens.get(cls)
        if (token === undefined) { notRun.push(`${r.op} / ${cls}: no credential file`); continue }
        for (const [i, variant] of variants.entries()) {
          const exp = row.exp[cls]?.[i] ?? 'N'
          const read = row.effect === 'read'
          if (exp === 'A' && !read && !allowMutations) { notRun.push(`${r.op} / ${cls} / ${variant}: allowed mutation, run with --allow-mutations on a disposable stack`); continue }
          const values: Record<string, string> = {}
          const path = (sample.path as string).replace(/\{(\w+)\}/g, (_: string, k: string) => encodeURIComponent((values[k] = String(fill(sample.params?.[k], k, variant, false)))))
          const query = fill(bodies[`${r.op}:query`] ?? sample.query, '', variant, false) as Record<string, string>
          const qs = new URLSearchParams(Object.entries(query ?? {}).map(([k, v]) => [k, String(v)])).toString()
          const body = sample.body === undefined ? undefined : fill(bodies[r.op] ?? sample.body, '', variant, false)
          const a = await call(sample.method, `${path}${qs === '' ? '' : `?${qs}`}`, token, body)
          const verdict = exp === 'N' ? (a.obs === 'X' ? 'DEFECT-5xx' : 'skipped') : a.obs === 'V' ? 'BAD-SAMPLE' : a.obs === 'X' ? 'DEFECT-5xx' : a.obs === 'R' ? 'RATE-LIMITED' : exp === a.obs ? 'ok' : exp === 'D' && a.obs === 'A' ? 'AUTHZ-BYPASS?' : 'OVER-RESTRICTIVE?'
          results.push({ row: r.op, cls, variant, exp, obs: a.obs, status: a.status, code: a.code, verdict })
          // existence oracle: a real object the credential may not see must answer like a fabricated one
          for (const [k, foreignId] of Object.entries(fixtures.foreign ?? {})) {
            if (values[k] === undefined) continue
            const real = await call(sample.method, path.replace(encodeURIComponent(values[k]), encodeURIComponent(foreignId)), token, body)
            if (real.status !== a.status || real.code !== a.code) {
              results.push({ row: `${r.op}#existence:${k}`, cls, variant, exp: 'same', obs: 'differs', status: real.status, code: real.code, verdict: `EXISTENCE-LEAK (fabricated id: ${a.status} ${a.code}; real foreign id: ${real.status} ${real.code})` })
            }
          }
          if (sent % 50 === 0) await sleep(200)
        }
      }
    }
  }
}

if (only !== 'rest') {
  notRun.push('mcp: JSON-RPC calls to /mcp are not implemented in this harness version; drive them with @exponetdb/testkit/mcp (reference client) using the `mcp-client` credential and authz-samples.json `mcp` args, then compare with `exp.mcp-client`')
}
notRun.push('web: actions whose only client kind is the Web App session need a passkey/TOTP browser session; the harness checks that every bearer credential is REFUSED for them (rows with exp D) and does not exercise the allowed side')

writeFileSync(`${outPrefix}.json`, JSON.stringify({ sent, base: `${base.protocol}//${base.host}`, results, notRun }, null, 1))
const bad = results.filter((r) => r.verdict !== 'ok' && r.verdict !== 'skipped')
const md = [
  `# Authorization matrix run (${results.length} calls, ${bad.length} not ok, ${notRun.length} not run)`,
  '',
  '| Row | Credential | Tier | Expected | Observed | Status | Code | Verdict |',
  '|---|---|---|---|---|---:|---|---|',
  ...bad.map((r) => `| ${r.row} | ${r.cls} | ${r.variant} | ${r.exp} | ${r.obs} | ${r.status} | ${r.code ?? ''} | ${r.verdict} |`),
  '',
  '## Not run',
  ...notRun.slice(0, 200).map((n) => `- ${n}`),
]
writeFileSync(`${outPrefix}.md`, md.join('\n') + '\n')
console.log(`calls ${sent}, results ${results.length}, not ok ${bad.length}, not run ${notRun.length}`)
