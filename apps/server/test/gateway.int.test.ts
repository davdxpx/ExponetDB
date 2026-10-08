import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { connect as http2Connect } from 'node:http2'
import { request as httpsRequest } from 'node:https'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import type { AgentApi } from '@exponetdb/application'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { systemClock } from '@exponetdb/kernel'
import { certificatePem, loadGatewayPki, mintGatewayIdentity } from '@exponetdb/nodes'
import { createLogger } from '@exponetdb/observability'
import { generateKeyringText, parseKeyring } from '@exponetdb/secrets'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCommand } from '../src/commands/index.ts'
import type { GatewayConfig } from '../src/config/env.ts'
import { listenAgentApi } from '../src/interfaces/gateway/agent-listener.ts'
import { runGateway } from '../src/roles/roles.ts'

/**
 * The gateway's agent listener and the PKI ceremony against PostgreSQL 17
 * (control-plane.md §3, §5): `exponetdb node-pki init` as the worker only,
 * the root key in a new 0600 file and nowhere else, the listener opened only
 * once the PKI exists, HTTP/2 over TLS 1.3 only, the gateway chain carrying
 * the pinned root, client certificates required except for enrollment, and
 * the catalog's error codes.
 */

let db: MigratedTestDatabase
let dir = ''
const keyring = generateKeyringText('k2026a')
const SERVER_NAME = 'gateway.exdb.test'

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_gateway')
  dir = await mkdtemp(join(tmpdir(), 'exdb-gateway-'))
})

afterAll(async () => {
  await db?.drop()
  await rm(dir, { recursive: true, force: true })
})

function io(env: Record<string, string>) {
  const out: string[] = []
  const err: string[] = []
  return {
    io: { env, stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) },
    out,
    err,
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const address = s.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      s.close(() => resolve(port))
    })
  })
}

async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await fn().catch(() => undefined as T)
    if ((v !== undefined && ok(v)) || Date.now() > deadline) {
      return v
    }
    await new Promise((r) => setTimeout(r, 200))
  }
}

interface Answer {
  readonly status: number
  readonly body: Record<string, unknown>
  readonly alpn: string | false | undefined
}

function agentRequest(
  port: number,
  ca: string,
  path: string,
  options: { body?: string; headers?: Record<string, string>; method?: string } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const session = http2Connect(`https://127.0.0.1:${port}`, {
      ca,
      servername: SERVER_NAME,
      minVersion: 'TLSv1.3',
    })
    session.on('error', reject)
    const req = session.request({
      ':method': options.method ?? 'POST',
      ':path': path,
      'content-type': 'application/json',
      ...options.headers,
    })
    let status = 0
    const chunks: Buffer[] = []
    req.on('response', (h) => {
      status = Number(h[':status'])
    })
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const alpn = session.alpnProtocol
      session.close()
      const text = Buffer.concat(chunks).toString('utf8')
      resolve({ status, body: text === '' ? {} : JSON.parse(text), alpn })
    })
    req.on('error', reject)
    if (options.body === undefined) {
      req.end()
    } else {
      req.end(options.body)
    }
  })
}

const PROTOCOL = {
  'x-exponetdb-protocol': 'exponetdb.node/v1',
  'x-exponetdb-agent-version': '1.0.0',
}

describe('node-pki init and the gateway agent listener', () => {
  it('runs the ceremony as the worker only, writes the root key once, and opens the listener', async () => {
    const out = join(dir, 'root-key.pem')
    const args = [
      'node-pki',
      'init',
      '--gateway-url',
      'https://10.8.2.2:7443',
      '--server-name',
      SERVER_NAME,
      '--root-key-out',
      out,
    ]
    const asServe = io({
      EXPONETDB_CONTROL_STORE_URL: db.url('exdb_serve'),
      EXPONETDB_KEYRING: keyring,
    })
    expect(await runCommand(args, asServe.io)).toBe(2)
    expect(asServe.err.join('')).toContain('worker_login_required')
    await expect(stat(out)).rejects.toThrow()

    const asWorker = io({
      EXPONETDB_CONTROL_STORE_URL: db.url('exdb_worker'),
      EXPONETDB_KEYRING: keyring,
    })
    expect(await runCommand(args, asWorker.io)).toBe(0)
    const report = JSON.parse(asWorker.out.join(''))
    expect(report.rootFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(asWorker.out.join('')).not.toContain('PRIVATE KEY')
    expect(((await stat(out)).mode & 0o777).toString(8)).toBe('600')
    // A second ceremony is refused and leaves no file behind.
    const again = join(dir, 'root-key-2.pem')
    expect(await runCommand([...args.slice(0, -1), again], asWorker.io)).toBe(1)
    await expect(stat(again)).rejects.toThrow()
    // The root key is nowhere in the Control Store.
    const pki = await db.asSuperuser((c) =>
      c.query('SELECT root_certificate, root_fingerprint FROM nodes.pki'),
    )
    expect(pki.rows[0].root_fingerprint).toBe(report.rootFingerprint)

    const port = await freePort()
    let release: () => void = () => undefined
    const until = new Promise<void>((resolve) => {
      release = resolve
    })
    let internal = 0
    const config: GatewayConfig = {
      logLevel: 'warn',
      otlpEndpoint: undefined,
      internalListen: { host: '127.0.0.1', port: 0 },
      shutdownTimeoutMs: 10_000,
      keyringEnv: { EXPONETDB_KEYRING: keyring },
      role: 'gateway',
      controlStoreUrl: db.url('exdb_gateway'),
      installationId: db.installationId,
      agentListen: { host: '127.0.0.1', port },
    }
    const exit = runGateway(config, {
      until,
      write: () => undefined,
      onListening: (p) => {
        internal = p.internal
      },
    })
    const ready = await eventually(
      async () => (await fetch(`http://127.0.0.1:${internal}/healthz/ready`)).status,
      (s) => s === 200,
    )
    expect(ready).toBe(200)

    const der: Buffer = pki.rows[0].root_certificate
    const rootPem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`
    // HTTP/2 over TLS 1.3, verified against the agent root for the server name.
    const malformed = await agentRequest(port, rootPem, '/agent/v1/enroll', {
      headers: PROTOCOL,
      body: '{"tokenId":1}',
    })
    expect(malformed.alpn).toBe('h2')
    expect(malformed).toMatchObject({ status: 422, body: { code: 'VALIDATION_FAILED' } })
    expect(await agentRequest(port, rootPem, '/agent/v1/enroll', { body: '{}' })).toMatchObject({
      status: 400,
      body: { code: 'NODE_PROTOCOL_UNSUPPORTED' },
    })
    // Every endpoint but enrollment needs a client certificate.
    expect(
      await agentRequest(port, rootPem, '/agent/v1/hello', { headers: PROTOCOL, body: '{}' }),
    ).toMatchObject({ status: 403, body: { code: 'NODE_CERTIFICATE_REFUSED', retryable: false } })
    expect(
      await agentRequest(port, rootPem, '/agent/v1/enroll', { headers: PROTOCOL, method: 'GET' }),
    ).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } })
    // Duplicate members are not JSON here.
    expect(
      await agentRequest(port, rootPem, '/agent/v1/enroll', {
        headers: PROTOCOL,
        body: '{"tokenId":"a","tokenId":"b"}',
      }),
    ).toMatchObject({ status: 422, body: { code: 'VALIDATION_FAILED' } })

    // TLS 1.2 and HTTP/1.1 are refused.
    await expect(
      new Promise((resolve, reject) => {
        const s = tlsConnect({
          host: '127.0.0.1',
          port,
          ca: rootPem,
          servername: SERVER_NAME,
          maxVersion: 'TLSv1.2',
        })
        s.on('secureConnect', () => {
          s.end()
          resolve('connected')
        })
        s.on('error', reject)
      }),
    ).rejects.toThrow()
    // An HTTP/1.1 client gets Node's bare refusal for a non-HTTP/2 client:
    // 403, no agent API, connection closed.
    const http1 = await new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        const req = httpsRequest(
          {
            host: '127.0.0.1',
            port,
            ca: rootPem,
            servername: SERVER_NAME,
            method: 'POST',
            path: '/agent/v1/enroll',
            headers: PROTOCOL,
          },
          (res) => {
            let body = ''
            res.on('data', (c) => {
              body += String(c)
            })
            res.on('end', () => resolve({ status: res.statusCode, body }))
          },
        )
        req.on('error', reject)
        req.end('{}')
      },
    ).catch(() => ({ status: undefined, body: '' }))
    expect(http1.status === undefined || http1.status === 403).toBe(true)
    expect(http1.body).not.toContain('VALIDATION_FAILED')

    // The agent-version header is part of the protocol.
    expect(
      await agentRequest(port, rootPem, '/agent/v1/enroll', {
        headers: { 'x-exponetdb-protocol': 'exponetdb.node/v1' },
        body: '{}',
      }),
    ).toMatchObject({ status: 400, body: { code: 'NODE_PROTOCOL_UNSUPPORTED' } })
    // An enrollment body is small; 1 MiB is for authenticated requests.
    expect(
      await agentRequest(port, rootPem, '/agent/v1/enroll', {
        headers: PROTOCOL,
        body: JSON.stringify({ tokenId: 'x'.repeat(17 * 1024) }),
      }),
    ).toMatchObject({ status: 422, body: { code: 'VALIDATION_FAILED' } })
    expect(
      await agentRequest(port, rootPem, '/agent/v1/enroll', {
        headers: { ...PROTOCOL, 'content-type': 'application/jsonx' },
        body: '{}',
      }),
    ).toMatchObject({ status: 422, body: { code: 'VALIDATION_FAILED' } })
    // Requests without a client certificate are limited per address.
    const codes: unknown[] = []
    for (let i = 0; i < 45; i++) {
      const r = await agentRequest(port, rootPem, '/agent/v1/enroll', {
        headers: PROTOCOL,
        body: '{}',
      })
      codes.push(r.body['code'])
    }
    expect(codes).toContain('RATE_LIMITED')

    release()
    expect(await exit).toBe(0)
  }, 60_000)

  it('keeps TLS 1.3 only after the identity swap and resets a stalled body', async () => {
    const parsed = parseKeyring(keyring)
    if (!parsed.ok) throw new Error('keyring')
    const pki = await loadGatewayPki(db.store('exdb_gateway'), parsed.value)
    if (pki === undefined) throw new Error('no PKI')
    const logs: string[] = []
    const refuse = async () => {
      throw Object.assign(new Error('refused'), { code: 'NODE_ENROLLMENT_REFUSED' })
    }
    const api = { enroll: refuse } as unknown as AgentApi
    const listener = await listenAgentApi({
      host: '127.0.0.1',
      port: 0,
      identity: mintGatewayIdentity(pki, systemClock),
      clientRootPem: certificatePem(pki.rootCertificate),
      api,
      logger: createLogger({ role: 'gateway', level: 'info', write: (l) => logs.push(l) }),
      bodyDeadlineMs: 300,
    })
    const rootPem = certificatePem(pki.rootCertificate)
    const tls12 = () =>
      new Promise((resolve, reject) => {
        const socket = tlsConnect({
          host: '127.0.0.1',
          port: listener.port,
          ca: rootPem,
          servername: SERVER_NAME,
          maxVersion: 'TLSv1.2',
        })
        socket.on('secureConnect', () => {
          socket.end()
          resolve(socket.getProtocol())
        })
        socket.on('error', reject)
      })
    try {
      await expect(tls12()).rejects.toThrow()
      // The daily swap: setSecureContext resets the versions its options omit.
      listener.setIdentity(mintGatewayIdentity(pki, systemClock))
      await expect(tls12()).rejects.toThrow()
      const answered = await agentRequest(listener.port, rootPem, '/agent/v1/enroll', {
        headers: PROTOCOL,
        body: '{}',
      })
      expect(answered).toMatchObject({ status: 422, alpn: 'h2' })

      // A body that stalls is reset without an answer (the agent retries).
      const outcome = await new Promise<string>((resolve) => {
        const session = http2Connect(`https://127.0.0.1:${listener.port}`, {
          ca: rootPem,
          servername: SERVER_NAME,
        })
        session.on('error', () => resolve('session_error'))
        const req = session.request({
          ':method': 'POST',
          ':path': '/agent/v1/enroll',
          'content-type': 'application/json',
          ...PROTOCOL,
        })
        req.on('response', (h) => resolve(`answered ${h[':status']}`))
        req.on('close', () => {
          resolve(`reset ${req.rstCode}`)
          session.close()
        })
        req.on('error', () => undefined)
        req.write('{"tokenId":')
      })
      expect(outcome).toBe('reset 8')

      // A refused enrollment is logged at info with its token id; the
      // redeem key never appears.
      const b = (n: number) => randomBytes(n).toString('base64url')
      const tokenId = 'ent_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z'
      const redeemKey = b(32)
      const refused = await agentRequest(listener.port, rootPem, '/agent/v1/enroll', {
        headers: PROTOCOL,
        body: JSON.stringify({
          tokenId,
          redeemKey,
          tlsKey: b(32),
          tlsKeyProof: b(64),
          nodeSigningKey: b(32),
          nodeSigningKeyProof: b(64),
          nodeEncryptionKey: b(32),
          bindProof: b(32),
          agentVersion: '1.0.0',
          protocolMajors: [1],
          host: {
            hostname: 'db-host-01',
            os: 'ubuntu 24.04',
            kernel: '6.8.0',
            cpus: 8,
            memoryBytes: 1 << 30,
            machineIdHash: `sha256:${'3'.repeat(64)}`,
          },
        }),
      })
      expect(refused).toMatchObject({ status: 401, body: { code: 'NODE_ENROLLMENT_REFUSED' } })
      const line = logs.find((l) => l.includes('agent.refused'))
      expect(line).toContain(tokenId)
      expect(line).toContain('NODE_ENROLLMENT_REFUSED')
      expect(logs.join('\n')).not.toContain(redeemKey)
    } finally {
      await listener.close(1000)
    }
  }, 30_000)
})
