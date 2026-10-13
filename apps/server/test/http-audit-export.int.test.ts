import { createHash } from 'node:crypto'
import { appendAuditEvent } from '@exponetdb/audit'
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
 * The audit export (Wave 8; owner decision 2026-10-13; audit.md §5.1) over
 * the real public app, on PostgreSQL 17: owners and admins, freshly
 * re-authenticated in the Web App, download the stored events verbatim as
 * NDJSON; nobody else can. An independent verifier written in this file from
 * the text of audit.md §4.1 and §5.1 (it imports nothing from packages/audit)
 * verifies a page, and fails on a one-byte change.
 */
let db: MigratedTestDatabase
let keyring: Keyring
let app: ReturnType<typeof createPublicApp>
let registry: KindRegistry
let owner: Person
let admin: Person
let operator: Person
let auditor: Person

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_http_audit_export')
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
  // No notification channel: activation must stay refused (OD-21).
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
  admin = await person('admin@example.test', 'admin')
  operator = await person('operator@example.test', 'operator')
  auditor = await person('auditor@example.test', 'auditor')
}, 240_000)

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

/** A person invited by the owner and bound to a role globally (the planned access change, applied). */
async function person(email: string, roleId: string): Promise<Person> {
  await owner.reauth()
  const invited = await owner.browser.call('POST', '/api/v1/identities', { email })
  expect(invited.status, invited.text).toBe(201)
  const enrolled = await enrollFromLink(
    (input, init) => app.request(input, init),
    invited.body.invitation.link,
  )
  const planned = await owner.browser.call('POST', '/api/v1/role-bindings', {
    identityId: enrolled.identityId,
    roleId,
    scope: { kind: 'global' },
  })
  expect(planned.status, planned.text).toBe(201)
  await owner.reauth()
  const applied = await owner.browser.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
  expect(applied.status, applied.text).toBe(202)
  await drive()
  return enrolled
}

/** A service account bound to a role and an API key for it. */
async function apiKey(roleId: string, scopes: string[]): Promise<string> {
  await owner.reauth()
  const created = await owner.browser.call('POST', '/api/v1/service-accounts', {
    displayName: `ci ${roleId}`,
  })
  expect(created.status, created.text).toBe(201)
  const planned = await owner.browser.call('POST', '/api/v1/role-bindings', {
    identityId: created.body.id,
    roleId,
    scope: { kind: 'global' },
  })
  expect(planned.status, planned.text).toBe(201)
  await owner.reauth()
  expect(
    (await owner.browser.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})).status,
  ).toBe(202)
  await drive()
  await owner.reauth()
  const key = await owner.browser.call(
    'POST',
    `/api/v1/service-accounts/${created.body.id}/api-keys`,
    {
      scopes,
      restrictions: { tiers: ['nonprod'], targets: { kind: 'all' } },
      lifetimeDays: 30,
    },
  )
  expect(key.status, key.text).toBe(201)
  return String(key.body.secret)
}

async function bearer(token: string, path: string, method = 'GET', body?: unknown) {
  const response = await app.request(`${ORIGIN}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return {
    status: response.status,
    // biome-ignore lint/suspicious/noExplicitAny: a parsed JSON body, asserted by each test.
    body: (text.length === 0 ? undefined : JSON.parse(text)) as any,
  }
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'

/** Moves every recorded re-authentication out of the 300 s window. */
async function ageReauth() {
  await db.asSuperuser(async (c) => {
    await c.query('BEGIN')
    await c.query('SET LOCAL session_replication_role = replica')
    await c.query(`UPDATE auth.reauth_events SET occurred_at = occurred_at - interval '10 minutes'`)
    await c.query(`UPDATE auth.web_sessions SET reauth_at = reauth_at - interval '10 minutes'
                    WHERE reauth_at IS NOT NULL`)
    await c.query('COMMIT')
  })
}

interface Download {
  readonly status: number
  readonly text: string
  readonly headers: Headers
  // biome-ignore lint/suspicious/noExplicitAny: parsed lines, asserted by each test.
  readonly lines: any[]
  // biome-ignore lint/suspicious/noExplicitAny: a problem document on errors.
  readonly problem: any
}

/** A GET with the person's session cookie, as a browser download link would send it. */
async function download(p: Person, query = ''): Promise<Download> {
  const cookie = [...p.browser.jar].map(([k, v]) => `${k}=${v}`).join('; ')
  const response = await app.request(`${ORIGIN}/api/v1/audit-events/export${query}`, {
    method: 'GET',
    headers: { cookie, 'user-agent': UA },
  })
  const text = await response.text()
  const ndjson = response.headers.get('content-type') === 'application/x-ndjson'
  return {
    status: response.status,
    text,
    headers: response.headers,
    lines: ndjson
      ? text
          .split('\n')
          .filter((l) => l !== '')
          .map((l) => JSON.parse(l))
      : [],
    problem: ndjson || text === '' ? undefined : JSON.parse(text),
  }
}

// ----- The independent verifier: written from audit.md §4.1 and §5.1 only -----

/** RFC 8785 for the values an event holds: sorted members (UTF-16 order), ES6 numbers and strings. */
function jcs(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${jcs(o[k])}`)
    .join(',')}}`
}

function frame(label: string, value: string): Buffer {
  const b = Buffer.from(value, 'utf8')
  return Buffer.concat([
    Buffer.from(`${label}\n${b.length}\n`, 'utf8'),
    b,
    Buffer.from('\n', 'utf8'),
  ])
}

function ac1(prevHash: string, event: unknown): string {
  const input = Buffer.concat([
    Buffer.from('exponetdb/audit-chain/ac1\n', 'utf8'),
    frame('prevHash', prevHash),
    frame('event', jcs(event)),
  ])
  return `sha256:ac1:${createHash('sha256').update(input).digest('hex')}`
}

type Verdict =
  | { readonly ok: true; readonly last: string | null }
  | { readonly ok: false; readonly seq: number | null; readonly reason: string }

/**
 * `anchor` is the known hash of `firstSeq - 1` (null when the page starts at the genesis).
 * Steps 1 to 6 of audit.md §5.1.
 */
function verifyPage(ndjson: string, anchor: string | null): Verdict {
  const lines = ndjson.split('\n').filter((l) => l !== '')
  const header = JSON.parse(lines[0] ?? 'null')
  if (
    header?.type !== 'header' ||
    header.format !== 'exponetdb.audit-export/v1' ||
    header.chain !== 'ac1'
  ) {
    return { ok: false, seq: null, reason: 'header' }
  }
  const events = lines.slice(1).map((l) => JSON.parse(l))
  if (events.length !== header.count) return { ok: false, seq: null, reason: 'count' }
  let previous: { seq: number; hash: string } | null = null
  const byseq = new Map<number, string>()
  for (const line of events) {
    if (line.type !== 'event') return { ok: false, seq: line.seq ?? null, reason: 'type' }
    if (ac1(line.prevHash, line.event) !== line.hash) {
      return { ok: false, seq: line.seq, reason: 'hash_mismatch' }
    }
    if (line.event.seq !== line.seq) return { ok: false, seq: line.seq, reason: 'seq_mismatch' }
    if (previous === null) {
      const anchored =
        line.seq === 1 ? /^ac1:genesis:ins_/.test(line.prevHash) : anchor === line.prevHash
      if (!anchored) return { ok: false, seq: line.seq, reason: 'anchor' }
    } else if (line.seq !== previous.seq + 1 || line.prevHash !== previous.hash) {
      return { ok: false, seq: line.seq, reason: 'linkage' }
    }
    previous = { seq: line.seq, hash: line.hash }
    byseq.set(line.seq, line.hash)
  }
  for (const c of header.checkpoints) {
    const hash = byseq.get(c.seq)
    if (hash !== undefined && hash !== c.hash) {
      return { ok: false, seq: c.seq, reason: 'checkpoint' }
    }
  }
  return { ok: true, last: previous?.hash ?? null }
}

async function storedRows(sql = 'TRUE') {
  const r = await db.asSuperuser((c) =>
    c.query(`SELECT seq, prev_hash, hash, event FROM audit.audit_events WHERE ${sql} ORDER BY seq`),
  )
  return r.rows as { seq: number; prev_hash: string; hash: string; event: string }[]
}

async function hashOf(seq: number): Promise<string> {
  const r = await db.asSuperuser((c) =>
    c.query('SELECT hash FROM audit.audit_events WHERE seq = $1', [seq]),
  )
  return r.rows[0]?.hash as string
}

const exportedEvents = () => storedRows("action = 'audit.export'")

describe('the audit export', () => {
  it('lets a freshly re-authenticated owner download the stored events verbatim, and an independent verifier accepts them', async () => {
    await owner.reauth()
    const before = (await exportedEvents()).length
    const r = await download(owner)
    expect(r.status, r.text).toBe(200)
    expect(r.headers.get('content-type')).toBe('application/x-ndjson')
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(r.headers.get('content-disposition')).toContain('attachment')
    expect(r.text.endsWith('\n')).toBe(true)

    const [header, ...events] = r.lines
    expect(header).toMatchObject({
      type: 'header',
      format: 'exponetdb.audit-export/v1',
      chain: 'ac1',
      from: null,
      to: null,
      firstSeq: 1,
      count: events.length,
      more: false,
      nextCursor: null,
    })
    expect(header.lastSeq).toBe(events.length)
    expect(Math.abs(Date.parse(header.generatedAt) - Date.now())).toBeLessThan(60_000)

    // Every line is the stored row: the event text unchanged, the stored hashes.
    const rows = await storedRows(`seq <= ${header.lastSeq}`)
    expect(events.length).toBe(rows.length)
    const textLines = r.text.split('\n')
    for (const [i, row] of rows.entries()) {
      expect(events[i]).toMatchObject({
        type: 'event',
        seq: Number(row.seq),
        prevHash: row.prev_hash,
        hash: row.hash,
      })
      // The embedded text is exactly the stored canonical text: byte for byte.
      expect(textLines[i + 1]?.endsWith(`"event":${row.event}}`), `line ${String(row.seq)}`).toBe(
        true,
      )
      expect(jcs(events[i].event)).toBe(row.event)
    }
    // Full fidelity: members the search view projects away are present.
    expect(events.some((e) => e.event.changes !== undefined)).toBe(true)

    expect(verifyPage(r.text, null)).toMatchObject({ ok: true })

    // The export is audited with range and count, never content; it is not in its own page.
    const audited = await exportedEvents()
    expect(audited.length).toBe(before + 1)
    const event = JSON.parse(audited.at(-1)?.event ?? '{}')
    expect(event).toMatchObject({
      action: 'audit.export',
      phase: 'completed',
      actor: { kind: 'human', identityId: owner.identityId },
      client: { kind: 'web' },
      changes: {
        from: null,
        to: null,
        firstSeq: 1,
        lastSeq: header.lastSeq,
        count: events.length,
        more: false,
        paged: false,
      },
      result: { status: 'succeeded' },
    })
    expect(event.actor.reauthAt).toEqual(expect.any(String))
    expect(JSON.stringify(event)).not.toContain('owner@example.test')
    expect(events.every((e) => e.event.id !== event.id)).toBe(true)

    // The next export contains it.
    const second = await download(owner)
    expect(second.lines.some((l) => l.type === 'event' && l.event.id === event.id)).toBe(true)
    expect(verifyPage(second.text, null)).toMatchObject({ ok: true })
  })

  it('lets a freshly re-authenticated admin export too', async () => {
    await admin.reauth()
    const r = await download(admin)
    expect(r.status, r.text).toBe(200)
    expect(verifyPage(r.text, null)).toMatchObject({ ok: true })
  })

  it('refuses a stale re-authentication, writes no export event, and works again after a new proof', async () => {
    await owner.reauth()
    await ageReauth()
    const before = (await exportedEvents()).length
    const r = await download(owner)
    expect(r.status).toBeGreaterThanOrEqual(400)
    expect(r.problem.code).toBe('REAUTH_REQUIRED')
    expect(r.text).not.toContain('"event"')
    expect((await exportedEvents()).length).toBe(before)
    await owner.reauth()
    expect((await download(owner)).status).toBe(200)
  })

  it('refuses the other roles, an API key and an anonymous caller', async () => {
    const viewer = await person('viewer@example.test', 'viewer')
    for (const p of [operator, auditor, viewer]) {
      await p.reauth()
      const r = await download(p)
      expect([r.status, r.problem.code], p.identityId).toEqual([403, 'PERMISSION_DENIED'])
      expect(r.text).not.toContain('"event"')
    }
    const key = await apiKey('admin', ['audit.read'])
    const viaKey = await bearer(key, '/api/v1/audit-events/export')
    expect(viaKey.status).toBe(403)
    expect(['INSUFFICIENT_SCOPE', 'PERMISSION_DENIED']).toContain(viaKey.body.code)
    const anonymous = await app.request(`${ORIGIN}/api/v1/audit-events/export`, {
      headers: { 'user-agent': UA },
    })
    expect(anonymous.status).toBe(401)
    // The auditor still reads the projection only.
    const search = await auditor.browser.call('GET', '/api/v1/audit-events?limit=1')
    expect(search.status).toBe(200)
    expect(search.body.items[0]).not.toHaveProperty('changes')
  })

  it('validates the range, the cursor and the page size with 422', async () => {
    await owner.reauth()
    for (const query of [
      '?from=yesterday',
      '?to=0',
      '?from=2026-13-45T10:00:00Z',
      '?from=5&to=5',
      '?from=9&to=3',
      '?from=2026-10-13T10:00:00Z&to=2026-10-13T09:00:00Z',
      '?limit=0',
      '?limit=10001',
      '?cursor=not-a-cursor!',
      '?cursor=x1_bm9wZQ',
      '?cursor=a1_MTA',
      '?unknown=1',
    ]) {
      const r = await download(owner, query)
      expect([r.status, r.problem?.code], query).toEqual([422, 'VALIDATION_FAILED'])
    }
  })

  it('exports a range by sequence or time, from inclusive and to exclusive', async () => {
    await owner.reauth()
    const bySeq = await download(owner, '?from=3&to=6')
    expect(bySeq.status, bySeq.text).toBe(200)
    expect(bySeq.lines.slice(1).map((l) => l.seq)).toEqual([3, 4, 5])
    expect(bySeq.lines[0]).toMatchObject({
      from: '3',
      to: '6',
      firstSeq: 3,
      lastSeq: 5,
      count: 3,
      more: false,
    })
    expect(verifyPage(bySeq.text, await hashOf(2))).toMatchObject({ ok: true })
    // Anchored wrongly, the same page fails.
    expect(verifyPage(bySeq.text, await hashOf(1))).toMatchObject({ ok: false, reason: 'anchor' })

    const stamps = await db.asSuperuser((c) =>
      c.query(
        `SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t
           FROM audit.audit_events WHERE seq IN (4, 6) ORDER BY seq`,
      ),
    )
    const [t4, t6] = stamps.rows.map((r) => r.t as string)
    const byTime = await download(owner, `?from=${t4}&to=${t6}`)
    expect(byTime.status, byTime.text).toBe(200)
    const seqs = byTime.lines.slice(1).map((l) => l.seq)
    expect(seqs[0]).toBe(4)
    expect(seqs.every((s: number) => s >= 4 && s < 6)).toBe(true)

    const empty = await download(owner, '?from=900000000')
    expect(empty.status).toBe(200)
    expect(empty.lines).toEqual([
      expect.objectContaining({
        type: 'header',
        firstSeq: null,
        lastSeq: null,
        count: 0,
        more: false,
        nextCursor: null,
        checkpoints: [],
      }),
    ])
  })

  it('pages with a cursor, joins the pages into one verifiable chain, and carries the checkpoints in range', async () => {
    await owner.reauth()
    await db.asSuperuser((c) =>
      c.query(
        `INSERT INTO audit.audit_chain_checkpoints (seq, hash, reason)
         SELECT seq, hash, 'manual' FROM audit.audit_events WHERE seq IN (4, 9)`,
      ),
    )
    const all: number[] = []
    let anchor: string | null = null
    let cursor = ''
    const pages: Download[] = []
    for (let i = 0; i < 100; i++) {
      const r = await download(owner, `?limit=4${cursor}`)
      expect(r.status, r.text).toBe(200)
      pages.push(r)
      const [h, ...events] = r.lines
      expect(events.length).toBeLessThanOrEqual(4)
      expect(h.count).toBe(events.length)
      const verdict = verifyPage(r.text, events[0]?.seq === 1 ? null : anchor)
      expect(verdict, `page ${i}`).toMatchObject({ ok: true })
      if (verdict.ok) anchor = verdict.last
      all.push(...events.map((e) => e.seq))
      if (!h.more) {
        expect(h.nextCursor).toBeNull()
        break
      }
      expect(h.nextCursor).toMatch(/^x1_[A-Za-z0-9_-]+$/)
      expect(events.length).toBe(4)
      cursor = `&cursor=${h.nextCursor}`
    }
    expect(all[0]).toBe(1)
    expect(all.every((s, i) => s === i + 1)).toBe(true)
    // The checkpoints that fall in a page (or are its anchor) are in its header.
    const withFour = pages.find((p) => p.lines[0].firstSeq <= 4 && p.lines[0].lastSeq >= 4)
    expect(withFour?.lines[0].checkpoints.map((c: { seq: number }) => c.seq)).toContain(4)
    expect(withFour?.lines[0].checkpoints[0]).toMatchObject({
      hash: await hashOf(4),
      createdAt: expect.any(String),
    })
    // A checkpoint that disagrees with an event fails the page.
    const forged = withFour?.text.replace(
      `"seq":4,"hash":"${await hashOf(4)}"`,
      `"seq":4,"hash":"sha256:ac1:${'0'.repeat(64)}"`,
    )
    expect(forged).not.toBe(withFour?.text)
    expect(verifyPage(forged ?? '', null)).toMatchObject({ ok: false })
  })

  it('fails the independent verifier on a change of one byte of one event', async () => {
    await owner.reauth()
    const r = await download(owner, '?to=12')
    expect(verifyPage(r.text, null)).toMatchObject({ ok: true })
    const lines = r.text.split('\n')
    // 1) one character of one event's content (line 0 is the header, so line 6 is seq 6)
    const target = lines[6] ?? ''
    expect(target).toContain('"phase":"')
    const edited = [...lines]
    edited[6] = target.replace(
      /"phase":"(.)/,
      (_m, c: string) => `"phase":"${c === 'x' ? 'y' : 'x'}`,
    )
    expect(edited[6]).not.toBe(target)
    expect(verifyPage(edited.join('\n'), null)).toMatchObject({
      ok: false,
      seq: 6,
      reason: 'hash_mismatch',
    })
    // 2) one character of a stored hash
    const hashEdit = [...lines]
    hashEdit[8] = (lines[8] ?? '').replace(
      /"hash":"sha256:ac1:([0-9a-f])/,
      (_m, d: string) => `"hash":"sha256:ac1:${d === '0' ? '1' : '0'}`,
    )
    expect(verifyPage(hashEdit.join('\n'), null)).toMatchObject({ ok: false, seq: 8 })
    // 3) a dropped event breaks the linkage
    const dropped = lines.filter((_l, i) => i !== 5)
    expect(
      verifyPage(dropped.join('\n').replace(/"count":\d+/, `"count":${r.lines.length - 2}`), null),
    ).toMatchObject({ ok: false, reason: 'linkage' })
    // 4) two events swapped
    const swapped = [...lines]
    ;[swapped[3], swapped[4]] = [swapped[4] ?? '', swapped[3] ?? '']
    expect(verifyPage(swapped.join('\n'), null)).toMatchObject({ ok: false })
  })
})

describe('the 10,000 event cap', () => {
  const EXTRA = 10_050

  it('serves at most 10,000 events per response, continues with the cursor, and the pages verify as one chain', async () => {
    const started = Date.now()
    const store = storeOf(db, 'exdb_serve')
    for (let done = 0; done < EXTRA; done += 1_000) {
      await store.transaction('test.audit.export.filler', async (tx) => {
        for (let i = 0; i < Math.min(1_000, EXTRA - done); i++) {
          await appendAuditEvent(
            tx,
            {
              action: 'test.filler',
              phase: 'completed',
              actor: { kind: 'system', identityId: null, label: 'system:maintenance' },
              changes: { n: done + i },
              result: { status: 'succeeded' },
            },
            { clock: systemClock },
          )
        }
      })
    }
    const total = (await storedRows()).length
    expect(total).toBeGreaterThan(10_000)
    expect(Date.now() - started).toBeLessThan(240_000)

    await owner.reauth()
    const first = await download(owner)
    expect(first.status, first.text.slice(0, 200)).toBe(200)
    expect(first.lines.length - 1).toBe(10_000)
    expect(first.lines[0]).toMatchObject({
      firstSeq: 1,
      lastSeq: 10_000,
      count: 10_000,
      more: true,
    })
    expect(first.lines[0].nextCursor).toMatch(/^x1_/)
    const one = verifyPage(first.text, null)
    expect(one).toMatchObject({ ok: true })

    const second = await download(owner, `?cursor=${first.lines[0].nextCursor}`)
    expect(second.status, second.text.slice(0, 200)).toBe(200)
    expect(second.lines[0]).toMatchObject({ firstSeq: 10_001, more: false, nextCursor: null })
    // The second page ends at the head the export saw: everything written before it was read.
    expect(second.lines.length - 1).toBeGreaterThanOrEqual(total - 10_000)
    expect(verifyPage(second.text, one.ok ? one.last : null)).toMatchObject({ ok: true })
    // Exactly 10,000 events in range and no further one: no `more`.
    const exact = await download(owner, '?to=10001')
    expect(exact.lines[0]).toMatchObject({ count: 10_000, more: false, nextCursor: null })
  }, 480_000)
})
