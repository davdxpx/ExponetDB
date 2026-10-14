import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { MCP_TOOL_LIST } from '@exponetdb/contracts'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { newId, systemClock } from '@exponetdb/kernel'
import { createLogger, MetricsRegistry, pass, Readiness } from '@exponetdb/observability'
import { KindRegistry, processNextOperation } from '@exponetdb/operations'
import {
  generateKeyringText,
  type Keyring,
  parseKeyring,
  registerActiveKey,
} from '@exponetdb/secrets'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { composeAccess, workerKinds } from '../src/composition/access.ts'
import type { ServeConfig } from '../src/config/env.ts'
import { createPublicApp, httpMetrics } from '../src/interfaces/http/app.ts'
import { enrollFromLink, enrollOwner, ORIGIN, type Person, storeOf } from './support/node-world.ts'

/**
 * The own profile (owner decision S10 of 2026-10-13) over the real public
 * app on PostgreSQL 17: a display name and a picture per person, changed
 * only by that person in the Web App, checked from the bytes, served with
 * the stored media type under a sandboxing policy, readable by the person
 * and by `access.read`, never written to the audit as text or bytes.
 * People: the owner, Alice (viewer), Aud (auditor: `access.read`) and Vic
 * (viewer: no `access.read`).
 */
let db: MigratedTestDatabase
let keyring: Keyring
let app: ReturnType<typeof createPublicApp>
let registry: KindRegistry
let owner: Person
let alice: Person
let aud: Person
let vic: Person
let invitedId = ''

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_http_profile')
  const parsed = parseKeyring(generateKeyringText('test-key'))
  if (!parsed.ok) throw new Error('keyring')
  keyring = parsed.value
  const worker = storeOf(db, 'exdb_worker')
  await registerActiveKey(worker, keyring)
  const config: ServeConfig = {
    role: 'serve',
    logLevel: 'warn',
    otlpEndpoint: undefined,
    controlStoreUrl: db.url('exdb_serve'),
    installationId: db.installationId,
    keyringEnv: {},
    internalListen: { host: '127.0.0.1', port: 0 },
    shutdownTimeoutMs: 10_000,
    listen: { host: '127.0.0.1', port: 0 },
    publicUrl: ORIGIN,
    webauthnRpId: undefined,
    trustedProxies: [],
    egressAddresses: [],
    mcpAllowedOrigins: [],
    clientRegistration: 'review',
  }
  const logger = createLogger({ role: 'serve', level: 'warn', write: () => undefined })
  const readiness = new Readiness(systemClock)
  readiness.register({ name: 'control_store', severity: 'critical', run: async () => pass() })
  readiness.register({ name: 'schema', severity: 'critical', run: async () => pass() })
  await readiness.evaluate()
  const access = composeAccess(
    config,
    { store: storeOf(db, 'exdb_serve'), keyring, readiness },
    { clock: systemClock },
  )
  expect((await access.roleCatalogCheck.run()).status).toBe('pass')
  expect((await access.scopeCatalogCheck.run()).status).toBe('pass')
  app = createPublicApp(
    {
      readiness: () => ({ status: 'ready', evaluatedAt: new Date().toISOString(), checks: [] }),
      version: '0.0.0-test',
      logger,
      metrics: httpMetrics(new MetricsRegistry()),
      clock: systemClock,
    },
    {
      api: {
        application: access.application,
        publicOrigin: ORIGIN,
        trustedProxies: [],
        logger,
        available: access.available,
      },
    },
  )
  owner = await enrollOwner(db, (input, init) => app.request(input, init))
  registry = new KindRegistry(
    workerKinds({ store: worker, keyring }, { clock: systemClock }, db.installationId),
  )
  alice = await invitePerson('alice@example.test', 'viewer')
  aud = await invitePerson('aud@example.test', 'auditor')
  vic = await invitePerson('vic@example.test', 'viewer')
  await owner.reauth()
  const pending = await owner.browser.call('POST', '/api/v1/identities', {
    email: 'pending@example.test',
  })
  expect(pending.status, pending.text).toBe(201)
  invitedId = String(pending.body.identity.id)
}, 300_000)

afterAll(async () => {
  await db?.drop()
})

async function drive() {
  for (let i = 0; i < 20; i++) {
    const r = await processNextOperation(storeOf(db, 'exdb_worker'), {
      workerId: newId('prc', Date.now()),
      kinds: registry,
      clock: systemClock,
    })
    if (r.status === 'idle') return
  }
}

async function invitePerson(email: string, roleId: string): Promise<Person> {
  await owner.reauth()
  const invited = await owner.browser.call('POST', '/api/v1/identities', { email })
  expect(invited.status, invited.text).toBe(201)
  const person = await enrollFromLink(
    (input, init) => app.request(input, init),
    invited.body.invitation.link,
  )
  await owner.reauth()
  const planned = await owner.browser.call('POST', '/api/v1/role-bindings', {
    identityId: person.identityId,
    roleId,
    scope: { kind: 'global' },
  })
  expect(planned.status, planned.text).toBe(201)
  await owner.reauth()
  const applied = await owner.browser.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
  expect(applied.status, applied.text).toBe(202)
  await drive()
  return person
}

// ----- pictures built byte by byte -----

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const cat = (...parts: (Uint8Array | readonly number[])[]) =>
  Uint8Array.from(parts.flatMap((p) => [...p]))
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
const le32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))
const chunk = (type: string, data: readonly number[] | Uint8Array) => {
  const body = cat(ascii(type), data)
  return cat(be32(data.length), body, be32(crc32(body)))
}
function png(width = 64, height = 64, extra: Uint8Array[] = []): Uint8Array {
  return cat(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    chunk('IHDR', [...be32(width), ...be32(height), 8, 2, 0, 0, 0]),
    ...extra,
    chunk('IDAT', deflateSync(new Uint8Array(4 * 13))),
    chunk('IEND', []),
  )
}
function jpeg(width = 96, height = 48): Uint8Array {
  return Uint8Array.from([
    ...[0xff, 0xd8],
    ...[0xff, 0xc0, 0, 17, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3],
    ...[1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
    ...[0xff, 0xda, 0, 12, 3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0, 0x12, 0x34, 0xff, 0x00, 0x56],
    ...[0xff, 0xd9],
  ])
}
function webp(width = 40, height = 40): Uint8Array {
  const bits = ((width - 1) | ((height - 1) << 14)) >>> 0
  const vp8l = cat(ascii('VP8L'), le32(6), [0x2f, ...le32(bits), 0x10])
  const body = cat(ascii('WEBP'), vp8l)
  return cat(ascii('RIFF'), le32(body.length), body)
}
const sha = (b: Uint8Array) => `sha256:${createHash('sha256').update(b).digest('hex')}`

// ----- raw requests of a person's browser -----

/** The user agent the test browser signs in with (a session is bound to it). */
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'

function cookies(person: Person): string {
  return [...person.browser.jar].map(([k, v]) => `${k}=${v}`).join('; ')
}

async function upload(
  person: Person,
  bytes: Uint8Array,
  type: string,
  options: { csrf?: boolean } = {},
) {
  const csrf = person.browser.jar.get('__Host-exdb_csrf')
  const response = await app.request(`${ORIGIN}/api/v1/me/avatar`, {
    method: 'PUT',
    headers: {
      'user-agent': UA,
      cookie: cookies(person),
      origin: ORIGIN,
      'content-type': type,
      ...(options.csrf === false || csrf === undefined ? {} : { 'x-csrf-token': csrf }),
    },
    body: bytes,
  })
  const text = await response.text()
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text), text }
}

async function picture(
  person: Person | undefined,
  path: string,
  extra: Record<string, string> = {},
) {
  const response = await app.request(`${ORIGIN}${path}`, {
    headers: {
      ...(person === undefined ? {} : { 'user-agent': UA, cookie: cookies(person) }),
      ...extra,
    },
  })
  return {
    status: response.status,
    headers: response.headers,
    bytes: new Uint8Array(await response.arrayBuffer()),
  }
}

const me = async (person: Person) => (await person.browser.call('GET', '/api/v1/me')).body

async function events(identityId: string) {
  return db.asSuperuser(async (c) =>
    (
      await c.query(
        `SELECT action, event FROM audit.audit_events
          WHERE action LIKE 'me.%' AND actor_id = $1 ORDER BY seq`,
        [identityId],
      )
    ).rows.map((r) => ({ action: String(r.action), event: String(r.event) })),
  )
}

const NAME = 'Ada Zebra-Marker Lovelace'

describe('the own display name', () => {
  it('starts empty: GET /me carries the profile as optional fields', async () => {
    const view = await me(alice)
    expect([view.displayName, view.avatar, view.profileRevision]).toEqual([null, null, 0])
    expect(view.identity.id).toBe(alice.identityId)
  })

  it('is set at a revision; a stale revision is 409; the answer is the profile', async () => {
    const set = await alice.browser.call('PUT', '/api/v1/me/profile', {
      displayName: NAME,
      revision: 0,
    })
    expect(set.status, set.text).toBe(200)
    expect(set.body).toMatchObject({
      identityId: alice.identityId,
      displayName: NAME,
      avatar: null,
      revision: 1,
    })
    expect(Date.parse(set.body.updatedAt)).not.toBeNaN()
    const stale = await alice.browser.call('PUT', '/api/v1/me/profile', {
      displayName: 'Other',
      revision: 0,
    })
    expect(stale.status, stale.text).toBe(409)
    expect(stale.body.code).toBe('CONFLICT')
    const view = await me(alice)
    expect([view.displayName, view.profileRevision]).toEqual([NAME, 1])
    // The name an admin gave at invitation is a separate field and unchanged.
    expect(view.identity.displayName).toBeNull()
  })

  it('refuses a name that is not one bounded line, and any field but the name and revision', async () => {
    for (const displayName of [
      '',
      'x'.repeat(65),
      'two\nlines',
      ' padded ',
      `rtl${String.fromCharCode(0x202e)}override`,
      `zero${String.fromCharCode(0x200b)}width`,
    ]) {
      const r = await alice.browser.call('PUT', '/api/v1/me/profile', { displayName, revision: 1 })
      expect(r.status, JSON.stringify(displayName)).toBe(422)
      expect(r.body.code).toBe('VALIDATION_FAILED')
    }
    // Another person's identity cannot even be named: the body is strict.
    const other = await alice.browser.call('PUT', '/api/v1/me/profile', {
      displayName: 'Hijack',
      revision: 1,
      identityId: owner.identityId,
    })
    expect(other.status).toBe(422)
    expect((await me(owner)).displayName).toBeNull()
    expect((await me(alice)).profileRevision).toBe(1)
  })

  it('changes only the caller: another person changes their own profile, never mine', async () => {
    const own = await vic.browser.call('PUT', '/api/v1/me/profile', {
      displayName: 'Vic',
      revision: 0,
    })
    expect(own.status, own.text).toBe(200)
    expect(own.body.identityId).toBe(vic.identityId)
    expect((await me(alice)).displayName).toBe(NAME)
    expect((await me(vic)).displayName).toBe('Vic')
  })

  it('is cleared with null at the current revision', async () => {
    const cleared = await vic.browser.call('PUT', '/api/v1/me/profile', {
      displayName: null,
      revision: 1,
    })
    expect(cleared.status, cleared.text).toBe(200)
    expect([cleared.body.displayName, cleared.body.revision]).toEqual([null, 2])
  })

  it('is a Web App action: CSRF is checked, an API caller without a session is refused', async () => {
    const response = await app.request(`${ORIGIN}/api/v1/me/profile`, {
      method: 'PUT',
      headers: {
        'user-agent': UA,
        cookie: cookies(alice),
        origin: ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ displayName: 'No CSRF', revision: 1 }),
    })
    expect(response.status).toBe(403)
    expect(((await response.json()) as { code: string }).code).toBe('CSRF_FAILED')
    const anonymous = await app.request(`${ORIGIN}/api/v1/me/profile`, {
      method: 'PUT',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Nobody', revision: 0 }),
    })
    expect(anonymous.status).toBe(401)
  })
})

describe('the own picture', () => {
  const first = png(64, 64)
  let firstUrl = ''

  it('is uploaded as raw bytes, answered with a same-origin address keyed by its hash', async () => {
    const r = await upload(alice, first, 'image/png')
    expect(r.status, r.text).toBe(200)
    expect(r.body.avatar).toEqual({
      url: `/api/v1/identities/${alice.identityId}/avatar?v=${sha(first)}`,
      sha256: sha(first),
      width: 64,
      height: 64,
    })
    expect([r.body.displayName, r.body.revision]).toEqual([NAME, 2])
    firstUrl = r.body.avatar.url
    expect((await me(alice)).avatar).toEqual(r.body.avatar)
  })

  it('is served with exactly the stored type and the specified headers', async () => {
    const r = await picture(alice, firstUrl)
    expect(r.status).toBe(200)
    expect(r.bytes).toEqual(first)
    expect(r.headers.get('content-type')).toBe('image/png')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect(r.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    // Revalidated on every use, never kept as fresh: access that ends ends at once.
    expect(r.headers.get('cache-control')).toBe('private, no-cache')
    expect(r.headers.get('etag')).toBe(`"${sha(first).slice('sha256:'.length)}"`)
    expect(r.headers.get('content-disposition')).toBe('inline')
    expect(r.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(r.headers.get('set-cookie')).toBeNull()
  })

  it('answers a matching If-None-Match with 304 and no bytes, only to a caller who may read it', async () => {
    const etag = `"${sha(first).slice('sha256:'.length)}"`
    const same = await picture(alice, firstUrl, { 'if-none-match': etag })
    expect(same.status).toBe(304)
    expect(same.bytes.length).toBe(0)
    expect(same.headers.get('etag')).toBe(etag)
    expect(same.headers.get('cache-control')).toBe('private, no-cache')
    expect((await picture(alice, firstUrl, { 'if-none-match': `W/${etag}, "x"` })).status).toBe(304)
    const other = await picture(alice, firstUrl, { 'if-none-match': '"0000"' })
    expect(other.status).toBe(200)
    expect(other.bytes).toEqual(first)
    // Revalidation never bypasses authorization: no 304 without access or without a session.
    expect((await picture(vic, firstUrl, { 'if-none-match': etag })).status).toBe(404)
    expect((await picture(undefined, firstUrl, { 'if-none-match': etag })).status).toBe(401)
  })

  it('is readable with access.read (the people list shows it), 404 for a viewer without it', async () => {
    expect((await picture(aud, firstUrl)).status).toBe(200)
    expect((await picture(owner, firstUrl)).status).toBe(200)
    const denied = await picture(vic, firstUrl)
    expect(denied.status).toBe(404)
    expect(denied.bytes.length).toBeGreaterThan(0)
    expect(new TextDecoder().decode(denied.bytes)).toContain('NOT_FOUND')
    expect((await picture(undefined, firstUrl)).status).toBe(401)
    const people = await owner.browser.call('GET', '/api/v1/identities')
    expect(people.status, people.text).toBe(200)
    const row = people.body.items.find((i: { id: string }) => i.id === alice.identityId)
    expect(row.avatar.url).toBe(firstUrl)
    expect(row.profileDisplayName).toBe(NAME)
    const one = await owner.browser.call('GET', `/api/v1/identities/${alice.identityId}`)
    expect(one.body.avatar.sha256).toBe(sha(first))
  })

  it('answers 404 for an unknown identity, an identity without a picture and a wrong hash', async () => {
    const unknown = `/api/v1/identities/${newId('idn', Date.now())}/avatar?v=${sha(first)}`
    expect((await picture(owner, unknown)).status).toBe(404)
    expect(
      (await picture(owner, `/api/v1/identities/${vic.identityId}/avatar?v=${sha(first)}`)).status,
    ).toBe(404)
    expect(
      (await picture(owner, firstUrl.replace(/v=sha256:[0-9a-f]{4}/, 'v=sha256:0000'))).status,
    ).toBe(404)
    expect((await picture(owner, `/api/v1/identities/${alice.identityId}/avatar`)).status).toBe(422)
  })

  it('accepts JPEG and WebP and replaces the earlier picture; the old address is gone', async () => {
    const j = jpeg(96, 48)
    const r = await upload(alice, j, 'image/jpeg')
    expect(r.status, r.text).toBe(200)
    expect([r.body.avatar.width, r.body.avatar.height]).toEqual([96, 48])
    expect((await picture(owner, firstUrl)).status).toBe(404)
    const served = await picture(alice, r.body.avatar.url)
    expect(served.headers.get('content-type')).toBe('image/jpeg')
    expect(served.bytes).toEqual(j)
    const w = webp(40, 40)
    const r2 = await upload(alice, w, 'image/webp')
    expect(r2.status, r2.text).toBe(200)
    expect((await picture(aud, r2.body.avatar.url)).headers.get('content-type')).toBe('image/webp')
  })

  it('stores, hashes and serves the picture without its metadata (GPS, text)', async () => {
    const gps = 'GPSLatitude=48.137154;GPSLongitude=11.576124'
    const clean = png(64, 64)
    const tagged = png(64, 64, [
      chunk('tEXt', [...ascii('Comment'), 0, ...ascii(gps)]),
      chunk('eXIf', [...ascii('MM'), 0, 42, ...ascii(gps)]),
    ])
    const r = await upload(owner, tagged, 'image/png')
    expect(r.status, r.text).toBe(200)
    expect(r.body.avatar.sha256).toBe(sha(clean))
    expect(r.body.avatar.url).toBe(`/api/v1/identities/${owner.identityId}/avatar?v=${sha(clean)}`)
    const served = await picture(owner, r.body.avatar.url)
    expect(served.bytes).toEqual(clean)
    const stored = await db.asSuperuser(async (c) =>
      (
        await c.query(
          'SELECT avatar, avatar_sha256 FROM profiles.identity_profiles WHERE identity_id = $1',
          [owner.identityId],
        )
      ).rows.map((row) => ({
        bytes: new Uint8Array(row.avatar),
        sha256: String(row.avatar_sha256),
      })),
    )
    expect(stored).toEqual([{ bytes: clean, sha256: sha(clean) }])
    expect(Buffer.from(stored[0]?.bytes ?? []).toString('latin1')).not.toContain('GPS')
    const removed = await owner.browser.call('DELETE', '/api/v1/me/avatar')
    expect(removed.status, removed.text).toBe(200)
  })

  it.each([
    [
      'SVG as SVG',
      new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      ),
      'image/svg+xml',
      '/headers/content-type',
      'invalid',
    ],
    [
      'SVG declared as PNG',
      new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      'image/png',
      '/body',
      'unsupported_format',
    ],
    [
      'GIF declared as GIF',
      cat(ascii('GIF89a'), [64, 0, 64, 0, 0, 0, 0, 0x3b]),
      'image/gif',
      '/headers/content-type',
      'invalid',
    ],
    [
      'GIF declared as PNG',
      cat(ascii('GIF89a'), [64, 0, 64, 0, 0, 0, 0, 0x3b]),
      'image/png',
      '/body',
      'unsupported_format',
    ],
    [
      'APNG',
      png(64, 64, [chunk('acTL', [...be32(2), ...be32(0)])]),
      'image/png',
      '/body',
      'animated',
    ],
    ['a PNG declared as JPEG', png(), 'image/jpeg', '/body', 'type_mismatch'],
    ['a truncated PNG', png().subarray(0, 50), 'image/png', '/body', 'malformed'],
    ['a PNG of 2048 pixels', png(2048, 2048), 'image/png', '/body', 'dimensions'],
    ['a PNG of 8 pixels', png(8, 8), 'image/png', '/body', 'dimensions'],
    [
      'a PNG with an HTML tail',
      cat(png(), new TextEncoder().encode('<html><script>alert(document.cookie)</script></html>')),
      'image/png',
      '/body',
      'trailing_data',
    ],
    [
      'more than 256 KiB',
      cat(png(), new Uint8Array(256 * 1024)),
      'image/png',
      '/body',
      'too_large',
    ],
  ] as const)('refuses %s with 422', async (_name, bytes, type, path, code) => {
    const before = (await me(alice)).avatar
    const r = await upload(alice, bytes, type)
    expect(r.status, r.text).toBe(422)
    expect(r.body.code).toBe('VALIDATION_FAILED')
    expect(r.body.details.errors).toEqual([expect.objectContaining({ path, code })])
    expect((await me(alice)).avatar).toEqual(before)
  })

  it('needs the CSRF proof of the session', async () => {
    const r = await upload(alice, png(), 'image/png', { csrf: false })
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('CSRF_FAILED')
  })

  it('is removed; removing nothing is not an error and changes nothing', async () => {
    const current = (await me(alice)).avatar
    const removed = await alice.browser.call('DELETE', '/api/v1/me/avatar')
    expect(removed.status, removed.text).toBe(200)
    expect(removed.body.avatar).toBeNull()
    expect(removed.body.displayName).toBe(NAME)
    expect((await picture(aud, current.url)).status).toBe(404)
    const again = await alice.browser.call('DELETE', '/api/v1/me/avatar')
    expect(again.status).toBe(200)
    expect(again.body.revision).toBe(removed.body.revision)
  })
})

describe('the audit of profile changes', () => {
  it('records the revision, the hash and the size; never the name and never the bytes', async () => {
    const list = await events(alice.identityId)
    expect(list.map((e) => e.action)).toEqual([
      'me.profile.update',
      'me.avatar.set',
      'me.avatar.set',
      'me.avatar.set',
      'me.avatar.delete',
    ])
    const first = png(64, 64)
    const base64 = Buffer.from(first).toString('base64')
    const hex = Buffer.from(first).toString('hex')
    for (const e of list) {
      expect(e.event).not.toContain('Zebra-Marker')
      expect(e.event).not.toContain(base64.slice(0, 24))
      expect(e.event).not.toContain(hex.slice(16, 64))
      expect(JSON.parse(e.event).actor.identityId).toBe(alice.identityId)
    }
    const update = JSON.parse(list[0]?.event ?? '{}')
    expect(update.changes).toEqual({ revision: 1, displayNameSet: true })
    const set = JSON.parse(list[1]?.event ?? '{}')
    expect(set.changes).toEqual({
      revision: 2,
      sha256: sha(first),
      bytes: first.length,
      mediaType: 'image/png',
      width: 64,
      height: 64,
    })
    expect(JSON.parse(list[4]?.event ?? '{}').changes).toMatchObject({ revision: 5 })
  })
})

describe('the Control Store', () => {
  const code = (role: 'exdb_serve' | 'exdb_worker', sql: string, params: unknown[]) =>
    db.asRole(role, async (c) => {
      try {
        await c.query(sql, params)
        return undefined
      } catch (error) {
        return String(Reflect.get(error as object, 'code'))
      }
    })

  it('lets serve change a profile only through its functions, and only of an active person', async () => {
    expect(
      await code(
        'exdb_serve',
        'UPDATE profiles.identity_profiles SET display_name = $2 WHERE identity_id = $1',
        [alice.identityId, 'x'],
      ),
    ).toBe('42501')
    expect(
      await code('exdb_serve', 'INSERT INTO profiles.identity_profiles (identity_id) VALUES ($1)', [
        owner.identityId,
      ]),
    ).toBe('42501')
    expect(
      await code('exdb_serve', 'DELETE FROM profiles.identity_profiles WHERE identity_id = $1', [
        alice.identityId,
      ]),
    ).toBe('42501')
    expect(
      await code('exdb_serve', 'SELECT profiles.set_display_name($1, 0, $2)', [
        invitedId,
        'Pending',
      ]),
    ).toBe('EXF02')
    expect(
      await code('exdb_serve', 'SELECT profiles.set_display_name($1, 99, $2)', [
        alice.identityId,
        'Stale',
      ]),
    ).toBe('EXF03')
    // The bytes must hash to the stored hash and start like their type.
    expect(
      await code('exdb_serve', `SELECT profiles.set_avatar($1, $2, 'image/png', $3, 64, 64)`, [
        alice.identityId,
        Buffer.from(png()),
        `sha256:${'0'.repeat(64)}`,
      ]),
    ).toBe('23514')
    expect(
      await code('exdb_serve', `SELECT profiles.set_avatar($1, $2, 'image/jpeg', $3, 64, 64)`, [
        alice.identityId,
        Buffer.from(png()),
        sha(png()),
      ]),
    ).toBe('23514')
    // The worker deletes only with an erasure, and never reads the name or the picture.
    expect(
      await code('exdb_worker', 'DELETE FROM profiles.identity_profiles WHERE identity_id = $1', [
        alice.identityId,
      ]),
    ).toBe('EXF01')
    expect(
      await code('exdb_worker', 'SELECT display_name FROM profiles.identity_profiles', []),
    ).toBe('42501')
    expect((await me(alice)).displayName).toBe(NAME)
  })
})

describe('the MCP catalog', () => {
  it('binds none of the profile actions', () => {
    for (const action of [
      'me.profile.update',
      'me.avatar.set',
      'me.avatar.delete',
      'identity.avatar.get',
    ]) {
      expect(
        MCP_TOOL_LIST.some((t) => t.action === action),
        action,
      ).toBe(false)
    }
  })
})
