/**
 * A scripted "human" for the disposable stack: the first owner of the installation,
 * enrolled once through the real Web App endpoints with a software passkey, a password
 * and TOTP (the same test authenticator the product's own suites use), then able to sign
 * in, re-authenticate, approve and drive plans over HTTP against the running `serve`.
 *
 * The owner's secrets live in one 0600 JSON file (STATE/owner.json) on the server. This
 * program never prints a secret: it prints ids, states and counts.
 *
 *   bun --conditions=@exponetdb/source human.ts enroll            (setup link on stdin)
 *   bun --conditions=@exponetdb/source human.ts device-approve <user code> <scope>...
 *   bun --conditions=@exponetdb/source human.ts consent <authorize url> <scope>...   (the CLI's loopback sign-in)
 *   bun --conditions=@exponetdb/source human.ts call <METHOD> <path> [json body]
 *   bun --conditions=@exponetdb/source human.ts apply <planId> [--approve]
 *   bun --conditions=@exponetdb/source human.ts approve <operationId>
 *   bun --conditions=@exponetdb/source human.ts stepup <step-up id> <code>
 *
 * Environment: EXSTACK_OWNER_FILE (default ./owner.json), EXSTACK_PUBLIC_URL.
 */
import { createHash, createPrivateKey, createSign } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { totpCodeAt } from '@exponetdb/auth'
import { SoftAuthenticator } from '@exponetdb/auth/testing'
import { Secret } from 'otpauth'

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'
const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString('base64url')
const sha256 = (d: Uint8Array | string) => createHash('sha256').update(d).digest()
export const ENDED = ['succeeded', 'failed', 'verification_failed', 'needs_attention', 'canceled']

export interface OwnerFile {
  readonly origin: string
  readonly rpId: string
  readonly identityId: string
  readonly credentialId: string
  readonly userHandle: string
  readonly privateKeyPkcs8: string
  readonly password: string
  readonly totpSecret: string
  readonly recoveryCodes: readonly string[]
}

export interface Reply {
  readonly status: number
  // biome-ignore lint/suspicious/noExplicitAny: parsed JSON, shape asserted by the caller.
  readonly body: any
  readonly text: string
  readonly location: string | null
}

/** The passkey of OwnerFile: same assertion bytes as the product's SoftAuthenticator (synced, counter 0). */
function assertion(o: OwnerFile, challenge: string) {
  const authData = Buffer.concat([sha256(o.rpId), Buffer.from([0x01 | 0x04 | 0x08 | 0x10]), Buffer.alloc(4)])
  const clientDataJSON = b64u(
    Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge, origin: o.origin, crossOrigin: false }),
    ),
  )
  const key = createPrivateKey({
    key: Buffer.from(o.privateKeyPkcs8, 'base64'),
    format: 'der',
    type: 'pkcs8',
  })
  const signer = createSign('SHA256')
  signer.update(Buffer.concat([authData, sha256(Buffer.from(clientDataJSON, 'base64url'))]))
  const id = b64u(Buffer.from(o.credentialId, 'base64'))
  return {
    id,
    rawId: id,
    type: 'public-key' as const,
    response: {
      clientDataJSON,
      authenticatorData: b64u(authData),
      signature: b64u(signer.sign(key)),
      userHandle: b64u(Buffer.from(o.userHandle, 'base64')),
    },
    clientExtensionResults: {},
    authenticatorAttachment: 'platform' as const,
  }
}

class Browser {
  readonly jar = new Map<string, string>()
  constructor(readonly origin: string) {}
  async call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Reply> {
    const headers: Record<string, string> = { 'user-agent': UA, ...extra }
    if (this.jar.size > 0) headers['cookie'] = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
    if (method !== 'GET') {
      headers['origin'] = this.origin
      const csrf = this.jar.get('__Host-exdb_csrf')
      if (csrf !== undefined) headers['x-csrf-token'] = csrf
    }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(`${this.origin}${path}`, {
      method,
      headers,
      redirect: 'manual',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';')
      const index = (pair ?? '').indexOf('=')
      const name = (pair ?? '').slice(0, index)
      if (/max-age=0/i.test(line)) this.jar.delete(name)
      else this.jar.set(name, (pair ?? '').slice(index + 1))
    }
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text.length === 0 ? undefined : JSON.parse(text)
    } catch {
      parsed = undefined
    }
    return { status: response.status, body: parsed, text, location: response.headers.get('location') }
  }
}

export class Human {
  readonly browser: Browser
  constructor(readonly owner: OwnerFile) {
    this.browser = new Browser(owner.origin)
  }

  static load(file = process.env['EXSTACK_OWNER_FILE'] ?? './owner.json'): Human {
    return new Human(JSON.parse(readFileSync(file, 'utf8')) as OwnerFile)
  }

  call = (method: string, path: string, body?: unknown, extra?: Record<string, string>) =>
    this.browser.call(method, path, body, extra)

  async signIn(): Promise<void> {
    const options = await this.call('POST', '/auth/login/passkey/options', {})
    must(options, 200, 'login options')
    const done = await this.call('POST', '/auth/login/passkey', {
      credential: assertion(this.owner, options.body.challenge),
    })
    must(done, 200, 'login')
  }

  async reauth(): Promise<void> {
    const options = await this.call('POST', '/auth/reauth/passkey/options', {})
    must(options, 200, 'reauth options')
    must(
      await this.call('POST', '/auth/reauth/passkey', {
        credential: assertion(this.owner, options.body.challenge),
      }),
      200,
      'reauth',
    )
  }

  /** The state of an operation as the owner reads it. */
  async operation(id: string) {
    const r = await this.call('GET', `/api/v1/operations/${id}`)
    must(r, 200, `GET operation ${id}`)
    return r.body as { id: string; state: string; applyOutcome: string; verificationOutcome: string; errorCode: string | null }
  }

  async finished(id: string, ms = 240_000) {
    const deadline = Date.now() + ms
    for (;;) {
      const op = await this.operation(id)
      if (ENDED.includes(op.state)) return op
      if (Date.now() > deadline) throw new Error(`operation ${id} did not end: ${op.state}`)
      await new Promise((r) => setTimeout(r, 400))
    }
  }

  /** Approves a pending operation as its own applier (self-approval acknowledged). */
  async approve(operationId: string, planHash: string): Promise<Reply> {
    await this.reauth()
    return this.call('POST', `/api/v1/approvals/${operationId}/approve`, {
      planHash,
      acknowledgeSelfApproval: true,
    })
  }

  /** Plans (POST), optionally re-authenticates, applies, approves when asked to, waits for the end. */
  async planAndApply(path: string, body: unknown, opts: { reauth?: boolean; approve?: boolean } = {}) {
    const planned = await this.call('POST', path, body)
    must(planned, 201, `plan ${path}`)
    if (opts.reauth === true) await this.reauth()
    const applied = await this.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
    must(applied, 202, `apply ${planned.body.id}`)
    if (applied.body.state === 'awaiting_approval' && opts.approve !== false) {
      const approved = await this.approve(applied.body.id, planned.body.planHash)
      must(approved, 200, `approve ${applied.body.id}`)
    }
    const op = await this.finished(applied.body.id)
    return { plan: planned.body, operation: op }
  }
}

export function must(r: Reply, status: number, what: string): void {
  if (r.status !== status) {
    // The body of a refusal carries a code and a message, never a secret.
    const code = r.body?.code ?? ''
    throw new Error(`${what}: HTTP ${r.status} (expected ${status}) ${code} ${String(r.body?.message ?? r.text).slice(0, 300)}`)
  }
}

// ----- first-owner enrollment -----

async function enroll(link: string, file: string): Promise<void> {
  const origin = process.env['EXSTACK_PUBLIC_URL'] ?? new URL(link).origin
  const rpId = new URL(origin).hostname
  const browser = new Browser(origin)
  const token = new URL(link).hash.replace('#token=', '')
  must(await browser.call('POST', '/auth/enrollment/redeem', { token }), 200, 'redeem')
  const options = await browser.call('POST', '/auth/enrollment/passkey/options', {})
  must(options, 200, 'passkey options')
  const authenticator = new SoftAuthenticator(new Uint8Array(Buffer.from(options.body.user.id, 'base64url')))
  const credential = authenticator.register({ challenge: options.body.challenge, origin, rpId })
  must(await browser.call('POST', '/auth/enrollment/passkey', { credential, label: 'stack' }), 200, 'passkey')
  const password = `stack ${b64u(Buffer.from(crypto.getRandomValues(new Uint8Array(18))))} fjord 42`
  must(await browser.call('POST', '/auth/enrollment/password', { password }), 200, 'password')
  const setup = await browser.call('POST', '/auth/enrollment/totp/options', {})
  must(setup, 200, 'totp options')
  const secret = Secret.fromBase32(setup.body.secret).bytes
  must(await browser.call('POST', '/auth/enrollment/totp', { code: totpCodeAt(secret, Date.now()) }), 200, 'totp')
  const done = await browser.call('POST', '/auth/enrollment/complete', {})
  must(done, 200, 'complete')
  const virtual = authenticator.forVirtualAuthenticator(rpId)
  const owner: OwnerFile = {
    origin,
    rpId,
    identityId: String(done.body.signedIn.identityId),
    credentialId: virtual.credentialId,
    userHandle: virtual.userHandle,
    privateKeyPkcs8: virtual.privateKey,
    password,
    totpSecret: setup.body.secret,
    recoveryCodes: done.body.recoveryCodes ?? [],
  }
  writeFileSync(file, `${JSON.stringify(owner)}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
  console.log(JSON.stringify({ enrolled: true, identityId: owner.identityId, recoveryCodes: owner.recoveryCodes.length }))
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)
  const file = process.env['EXSTACK_OWNER_FILE'] ?? './owner.json'
  if (cmd === 'enroll') {
    if (existsSync(file)) throw new Error(`${file} exists: the first owner is already enrolled`)
    const link = (await new Response(Bun.stdin.stream()).text()).trim()
    // The link is JSON from `bootstrap owner` or a bare URL.
    const url = link.startsWith('{') ? String(JSON.parse(link).link ?? JSON.parse(link).setupLink ?? JSON.parse(link).url) : link
    await enroll(url, file)
    return
  }
  const human = Human.load(file)
  await human.signIn()
  switch (cmd) {
    case 'device-approve': {
      const [userCode, ...scopes] = rest
      const tiers = scopes.some((s) => s.endsWith(':prod')) ? ['nonprod', 'prod'] : ['nonprod']
      const r = await human.call('POST', '/auth/oauth/device', {
        userCode,
        decision: 'allow',
        scopes: scopes.map((s) => s.replace(/:(prod|nonprod)$/, (m) => m)),
        tiers,
        lifetimeDays: 30,
      })
      console.log(JSON.stringify({ status: r.status, body: r.body }))
      if (r.status !== 200) process.exit(1)
      return
    }
    case 'consent': {
      // The loopback sign-in of the CLI (PKCE): the owner opens the printed URL, consents, and the browser follows
      // the redirect to the CLI's one-shot listener on 127.0.0.1.
      const [url, ...scopes] = rest
      const u = new URL(String(url))
      const started = await human.call('GET', `${u.pathname}${u.search}`)
      if (started.status !== 302 || started.location === null) throw new Error(`authorize: HTTP ${started.status}`)
      const handle = started.location.slice(started.location.indexOf('#request=') + '#request='.length)
      const production = scopes.some((s) => s.endsWith(':prod'))
      const tiers = production ? ['nonprod', 'prod'] : ['nonprod']
      if (production) await human.reauth()
      const decided = await human.call('POST', '/auth/oauth/consent', {
        request: handle,
        decision: 'allow',
        scopes,
        tiers,
        lifetimeDays: 30,
        ...(production ? { acknowledgeProduction: true } : {}),
      })
      must(decided, 200, 'consent')
      const delivered = await fetch(String(decided.body.redirectTo), { redirect: 'manual' })
      console.log(JSON.stringify({ consent: decided.status, delivered: delivered.status, scopes: scopes.length, tiers }))
      return
    }
    case 'call': {
      const [method, path, body] = rest
      await human.reauth()
      const r = await human.call(method ?? 'GET', path ?? '/', body === undefined ? undefined : JSON.parse(body))
      console.log(JSON.stringify({ status: r.status, body: r.body ?? r.text }))
      return
    }
    case 'apply': {
      const [planId, flag] = rest
      await human.reauth()
      const applied = await human.call('POST', `/api/v1/plans/${planId}/apply`, {})
      console.log(JSON.stringify({ status: applied.status, state: applied.body?.state, operationId: applied.body?.id, code: applied.body?.code }))
      if (applied.status === 202 && applied.body.state === 'awaiting_approval' && flag === '--approve') {
        const plan = await human.call('GET', `/api/v1/plans/${planId}`)
        const r = await human.approve(applied.body.id, plan.body.planHash)
        console.log(JSON.stringify({ approve: r.status, code: r.body?.code }))
      }
      return
    }
    case 'approve': {
      const [operationId] = rest
      const op = await human.call('GET', `/api/v1/operations/${operationId}`)
      const planId = op.body?.planId
      const plan = await human.call('GET', `/api/v1/plans/${planId}`)
      const r = await human.approve(String(operationId), plan.body.planHash)
      console.log(JSON.stringify({ status: r.status, code: r.body?.code, state: r.body?.state }))
      return
    }
    case 'stepup': {
      const [stepUpId, code] = rest
      await human.reauth()
      const r = await human.call('POST', `/api/v1/step-ups/${stepUpId}/confirm`, code === undefined ? {} : { code })
      console.log(JSON.stringify({ status: r.status, body: r.body ?? r.text }))
      return
    }
    default:
      throw new Error('commands: enroll | device-approve | call | apply | approve | stepup')
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(String(error instanceof Error ? error.message : error))
    process.exit(1)
  })
}
