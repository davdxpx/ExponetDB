import {
  diffDocuments,
  fingerprintOf,
  makeDocument,
  makeEntry,
  scopeHeader,
} from '@exponetdb/postgres'
import { describe, expect, it } from 'vitest'
import {
  type CurrentSchema,
  capDriftItems,
  clip,
  type DriftCheckRecord,
  dedupKeyOf,
  driftCheckSummaryView,
  driftItems,
  encodeDocument,
  listSchemaObjectsView,
  MAX_DIFF_ITEMS,
  objectLabel,
  objectRef,
  parseQualifiedName,
  schemaDiffView,
} from '../src/index.ts'

/**
 * Drift classification, object references and diffs on canonical documents
 * built here (drift-detection.md §4, §6; order §91, §139 to §141).
 */
const header = scopeHeader(17, { excludeSchemas: ['audit_archive'] })
const acl = (to: string | null, privilege: string) => ({
  to,
  by: 'owner',
  privilege,
  grantable: false,
})

const table = (name: string, over: Record<string, unknown> = {}) =>
  makeEntry('table', ['public', name], {
    owner: 'owner',
    acl: [acl('owner', 'SELECT')],
    rowSecurity: true,
    rowSecurityForced: true,
    ...over,
  } as never)
const column = (t: string, name: string, type = 'text') =>
  makeEntry('column', ['public', t, name], { position: 1, type, notNull: true })
const policy = (t: string, name: string, using = '(owner_id = auth_uid())') =>
  makeEntry('policy', ['public', t, name], { command: 'select', roles: [null], using })
const fn = (name: string, over: Record<string, unknown> = {}) =>
  makeEntry('function', ['public', name, 'integer'], {
    language: 'sql',
    bodyDigest: 'a'.repeat(64),
    owner: 'owner',
    ...over,
  } as never)

const expected = makeDocument(header, [
  table('accounts'),
  column('accounts', 'email'),
  policy('accounts', 'own_rows'),
  fn('helper'),
  table('notes', { rowSecurity: false, rowSecurityForced: false }),
])

describe('drift items', () => {
  it('makes extension members, view options and SECURITY DEFINER bodies critical (G4 correction)', () => {
    const view = (options: string[]) =>
      makeEntry('view', ['public', 'v'], {
        definition: 'SELECT 1',
        reloptions: options,
        owner: 'o',
      })
    const ext = (members: string[][]) =>
      makeEntry('extension', ['hstore'], { version: '1.8', schema: 'public', members })
    const before = makeDocument(header, [
      ext([['function', 'public.hstore_in(pg_catalog.cstring)']]),
      view(['security_invoker=true']),
      fn('definer', { securityDefiner: true }),
      fn('invoker'),
    ])
    const after = makeDocument(header, [
      ext([
        ['function', 'public.hstore_in(pg_catalog.cstring)'],
        ['table', 'public.accounts'],
      ]),
      view(['security_invoker=false']),
      fn('definer', { securityDefiner: true, bodyDigest: 'b'.repeat(64) }),
      fn('invoker', { bodyDigest: 'b'.repeat(64) }),
    ])
    const items = driftItems(diffDocuments(before, after))
    const of = (cls: string, name: string) =>
      items.find((i) => i.entry.class === cls && i.entry.key.includes(name))
    // The diff contract's classification (schema-diff.json) is unchanged; the severity is critical.
    expect(of('extension', 'hstore')).toMatchObject({
      severity: 'critical',
      securityRelevant: false,
    })
    expect(of('view', 'v')).toMatchObject({ severity: 'critical', securityRelevant: false })
    expect(of('function', 'definer')).toMatchObject({
      severity: 'critical',
      securityRelevant: false,
    })
    expect(of('function', 'invoker')).toMatchObject({
      severity: 'warning',
      securityRelevant: false,
    })
    // Critical drift comes first (it survives the cap).
    expect(items.at(-1)?.entry.key).toContain('invoker')
  })

  it('makes the overflow critical when the cap leaves out drift that is critical only by severity', () => {
    const view = (name: string, options: string[]) =>
      makeEntry('view', ['public', name], {
        definition: 'SELECT 1',
        reloptions: options,
        owner: 'owner',
      } as never)
    const before = makeDocument(header, [
      view('a', ['security_invoker=true']),
      view('b', ['security_invoker=true']),
    ])
    const after = makeDocument(header, [
      view('a', ['security_invoker=false']),
      view('b', ['security_invoker=false']),
    ])
    const items = driftItems(diffDocuments(before, after))
    expect(items.map((i) => [i.severity, i.securityRelevant])).toEqual([
      ['critical', false],
      ['critical', false],
    ])
    expect(capDriftItems(items, new Map(), 1)).toMatchObject({
      fresh: 1,
      omitted: 1,
      omittedCritical: true,
      omittedSecurity: false,
    })
    // An item whose finding is open is recorded again and does not take the slot.
    const open = new Map([[items[1]?.dedupKey ?? '', true]])
    expect(capDriftItems(items, open, 1)).toMatchObject({ fresh: 1, omitted: 0 })
  })

  it('finds nothing between equal documents', () => {
    expect(driftItems(diffDocuments(expected, expected))).toEqual([])
  })

  it('classifies out-of-band changes and makes the security-relevant ones critical', () => {
    const actual = makeDocument(header, [
      // RLS no longer forced, an extra grant to PUBLIC.
      table('accounts', {
        rowSecurityForced: false,
        acl: [acl('owner', 'SELECT'), acl(null, 'SELECT')],
      }),
      column('accounts', 'email', 'character varying(320)'),
      // the policy is gone; a SECURITY DEFINER function appeared
      fn('helper'),
      fn('escalate', { securityDefiner: true }),
      table('notes', { rowSecurity: false, rowSecurityForced: false }),
      table('scratch', { rowSecurity: false, rowSecurityForced: false }),
    ])
    const items = driftItems(diffDocuments(expected, actual))
    const summary = items.map((i) => [i.code, objectLabel(i.entry), i.severity])
    expect(summary).toEqual(
      expect.arrayContaining([
        ['object_changed', 'table public.accounts', 'critical'],
        ['object_removed', 'policy public.accounts.own_rows', 'critical'],
        ['object_added', 'function public.escalate(integer)', 'critical'],
        ['object_changed', 'column public.accounts.email', 'warning'],
        ['object_added', 'table public.scratch', 'warning'],
      ]),
    )
    expect(items).toHaveLength(5)
    // Security-relevant first.
    expect(items.slice(0, 3).every((i) => i.securityRelevant)).toBe(true)
    const accounts = items.find((i) => objectLabel(i.entry) === 'table public.accounts')
    expect(accounts?.attributes).toEqual(['acl', 'rowSecurityForced'])
  })

  it.each([
    ['row security disabled', { rowSecurity: false }],
    ['FORCE row security removed', { rowSecurityForced: false }],
    ['a grant added', { acl: [acl('owner', 'SELECT'), acl('app', 'DELETE')] }],
    ['the owner changed', { owner: 'someone_else' }],
  ])('treats %s on a table as critical', (_what, over) => {
    const actual = makeDocument(header, [
      table('accounts', over),
      ...expected.entries.filter((e) => !(e.class === 'table' && e.key[1] === 'accounts')),
    ])
    const [item] = driftItems(diffDocuments(expected, actual))
    expect(item).toMatchObject({
      code: 'object_changed',
      severity: 'critical',
      securityRelevant: true,
    })
  })

  it.each([
    ['SECURITY DEFINER set', { securityDefiner: true }],
    ['search_path configured', { config: ['search_path=public'] }],
    ['EXECUTE granted', { acl: [acl(null, 'EXECUTE')] }],
  ])('treats %s on a function as critical', (_what, over) => {
    const actual = makeDocument(header, [
      fn('helper', over),
      ...expected.entries.filter((e) => e.class !== 'function'),
    ])
    const [item] = driftItems(diffDocuments(expected, actual))
    expect(item).toMatchObject({ severity: 'critical', securityRelevant: true })
  })

  it('treats a changed policy expression as critical, a changed function body as a warning', () => {
    const policyChanged = makeDocument(header, [
      ...expected.entries.filter((e) => e.class !== 'policy'),
      policy('accounts', 'own_rows', 'true'),
    ])
    expect(driftItems(diffDocuments(expected, policyChanged))[0]).toMatchObject({
      severity: 'critical',
    })
    const bodyChanged = makeDocument(header, [
      ...expected.entries.filter((e) => e.class !== 'function'),
      fn('helper', { bodyDigest: 'b'.repeat(64) }),
    ])
    expect(driftItems(diffDocuments(expected, bodyChanged))[0]).toMatchObject({
      severity: 'warning',
      attributes: ['bodyDigest'],
    })
  })

  it('keys a finding by drift kind, code and object, never by position or time', () => {
    const e = table('accounts')
    expect(dedupKeyOf('object_changed', e)).toBe(
      dedupKeyOf('object_changed', table('accounts', { owner: 'x' })),
    )
    expect(dedupKeyOf('object_changed', e)).not.toBe(dedupKeyOf('object_removed', e))
    expect(dedupKeyOf('object_changed', e)).toMatch(/^C:object_changed:table:[0-9a-f]{64}$/)
    // A dot inside a name never collides with a schema boundary.
    const dotted = makeEntry('table', ['public.accounts', 'x'])
    const plain = makeEntry('table', ['public', 'accounts.x'])
    expect(dedupKeyOf('object_added', dotted)).not.toBe(dedupKeyOf('object_added', plain))
  })
})

describe('object references and names', () => {
  it('names objects with quoting for hostile names and keeps the canonical key', () => {
    const hostile = makeEntry('table', ['public', 'x"; DROP TABLE y; --'])
    expect(objectLabel(hostile)).toBe('table public."x""; DROP TABLE y; --"')
    expect(objectRef(hostile)).toMatchObject({
      kind: 'table',
      schema: 'public',
      name: 'x"; DROP TABLE y; --',
      key: ['public', 'x"; DROP TABLE y; --'],
    })
    expect(objectRef(policy('accounts', 'own_rows'))).toMatchObject({
      kind: 'policy',
      parent: 'accounts',
      name: 'own_rows',
    })
    expect(objectRef(fn('helper'))).toMatchObject({ kind: 'function', signature: 'integer' })
    expect(objectRef(makeEntry('function', ['public', 'p', ''], { kind: 'p' }))).toMatchObject({
      kind: 'procedure',
    })
    expect(objectRef(makeEntry('enum', ['public', 'mood'], { labels: ['a'] }))).toMatchObject({
      kind: 'type',
    })
  })

  it.each([
    ['public.accounts', { parts: ['public', 'accounts'], signature: null }],
    ['"my schema"."a.b"', { parts: ['my schema', 'a.b'], signature: null }],
    ['public."say ""hi"""', { parts: ['public', 'say "hi"'], signature: null }],
    ['public.accounts.own_rows', { parts: ['public', 'accounts', 'own_rows'], signature: null }],
    ['public.f(integer, text)', { parts: ['public', 'f'], signature: 'integer, text' }],
    ['public.f()', { parts: ['public', 'f'], signature: '' }],
    ['Public.Accounts', { parts: ['Public', 'Accounts'], signature: null }],
  ])('parses %s', (text, parsed) => {
    expect(parseQualifiedName(text)).toEqual(parsed)
  })

  it.each(['public.', '.x', 'a..b', '"open', 'public.f(integer'])('refuses %s', (text) => {
    expect(parseQualifiedName(text)).toBeUndefined()
  })
})

describe('schema diffs', () => {
  it('groups changes by kind, counts before any cap and lists security-relevant objects', () => {
    const actual = makeDocument(header, [
      table('accounts', { rowSecurity: false }),
      column('accounts', 'email'),
      fn('helper'),
      table('notes', { rowSecurity: false, rowSecurityForced: false }),
    ])
    const view = schemaDiffView(expected, actual)
    expect(view.comparable).toBe(true)
    expect(view.totals).toEqual({
      added: 0,
      removed: 1,
      changed: 1,
      matched: 3,
      securityRelevant: 2,
    })
    expect(view.groups.map((g) => g.objectClass)).toEqual(['policy', 'table'])
    expect(view.securityRelevant.map((r) => r.kind).sort()).toEqual(['policy', 'table'])
    expect(view.truncated).toBe(false)
  })

  it('marks fingerprints of different majors as not comparable and still diffs the structure', () => {
    const other = makeDocument(
      scopeHeader(18, { excludeSchemas: ['audit_archive'] }),
      expected.entries,
    )
    const view = schemaDiffView(expected, other)
    expect(view.comparable).toBe(false)
    expect(view.totals.changed + view.totals.added + view.totals.removed).toBe(0)
    expect(view.left.fingerprint).not.toBe(view.right.fingerprint)
  })

  it('caps the listed objects and says so, with totals before the cap', () => {
    const many = makeDocument(header, [
      ...expected.entries,
      ...Array.from({ length: MAX_DIFF_ITEMS + 5 }, (_, i) => table(`t${i}`)),
    ])
    const view = schemaDiffView(expected, many)
    const listed = view.groups.reduce(
      (n, g) => n + g.added.length + g.removed.length + g.changed.length,
      0,
    )
    expect(listed).toBe(MAX_DIFF_ITEMS)
    expect(view.totals.added).toBe(MAX_DIFF_ITEMS + 5)
    expect(view.truncated).toBe(true)
  })
})

describe('stored documents', () => {
  it('encodes a document deterministically, independent of entry order', () => {
    const shuffled = makeDocument(header, [...expected.entries].reverse())
    expect(encodeDocument(shuffled)).toEqual(encodeDocument(expected))
    expect(encodeDocument(expected).digest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})

describe('listing the objects of a snapshot without a search term (Wave 8 completion)', () => {
  const index = (t: string, name: string) =>
    makeEntry('index', ['public', name], { table: ['public', t], unique: false } as never)
  const document = makeDocument(header, [
    makeEntry('schema', ['public'], { owner: 'owner' } as never),
    makeEntry('schema', ['billing'], { owner: 'owner' } as never),
    table('accounts'),
    table('notes'),
    makeEntry('table', ['billing', 'invoices'], { owner: 'owner', acl: [] } as never),
    column('accounts', 'email'),
    column('accounts', 'name'),
    column('notes', 'body'),
    index('accounts', 'accounts_email_idx'),
    fn('helper'),
    fn('Zeta'),
  ])
  const current = (doc = document, takenAt = '2026-10-20T10:00:00.000000Z'): CurrentSchema => ({
    document: doc,
    snapshot: {
      snapshotId: 'smp_01M48WRFNFYAY62E1146SMP001',
      targetId: 'tgt_01M48WRFNFYAY62E1146TGT001',
      generation: 1,
      fingerprint: fingerprintOf(doc),
      complete: true,
      visibility: [],
      missingSchemas: [],
      excludedSchemas: [],
      serverVersionNum: 170004,
      purpose: 'read',
      durationMs: 5,
      operationId: null,
      takenAt,
    },
    source: 'cached',
  })
  const list = (
    filter: Parameters<typeof listSchemaObjectsView>[1] = {},
    page: { limit: number; cursor?: string } = { limit: 100 },
    c = current(),
  ) => listSchemaObjectsView(c, filter, page)
  const labels = (items: readonly { kind: string; schema: string; name: string }[]) =>
    items.map((i) => `${i.schema}.${i.kind}.${i.name}`)

  it('lists every object when no filter is given, in schema, kind, name, signature order', () => {
    const all = list()
    expect(all.total).toBe(document.entries.length)
    expect(all.items).toHaveLength(document.entries.length)
    expect(labels(all.items).slice(0, 4)).toEqual([
      'billing.schema.billing',
      'billing.table.invoices',
      'public.column.body',
      'public.column.email',
    ])
    // Sorted by schema, then kind, then name (UTF-8 byte order: upper case before lower case).
    const sorted = [...all.items].sort(
      (a, b) =>
        Buffer.compare(Buffer.from(a.schema), Buffer.from(b.schema)) ||
        Buffer.compare(Buffer.from(a.kind), Buffer.from(b.kind)) ||
        Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)),
    )
    expect(labels(all.items)).toEqual(labels(sorted))
    expect(all.items.findIndex((i) => i.name === 'Zeta')).toBeLessThan(
      all.items.findIndex((i) => i.name === 'helper'),
    )
    expect(all).toMatchObject({
      nextCursor: null,
      fingerprint: fingerprintOf(document),
      complete: true,
      source: 'cached',
      observedAt: '2026-10-20T10:00:00.000000Z',
    })
  })

  it('filters by kind, schema, parent and name, combined with AND, and counts what matches before paging', () => {
    expect(labels(list({ kinds: ['table'] }).items)).toEqual([
      'billing.table.invoices',
      'public.table.accounts',
      'public.table.notes',
    ])
    expect(labels(list({ kinds: ['table', 'schema'], schema: 'billing' }).items)).toEqual([
      'billing.schema.billing',
      'billing.table.invoices',
    ])
    const children = list({ schema: 'public', parent: 'accounts' })
    expect(labels(children.items)).toEqual([
      'public.column.email',
      'public.column.name',
      'public.index.accounts_email_idx',
    ])
    expect(children.total).toBe(3)
    expect(list({ parent: 'nothing' }).total).toBe(0)
    // The name rule is the search's: a case-insensitive substring.
    expect(labels(list({ q: 'EMAIL' }).items)).toEqual([
      'public.column.email',
      'public.index.accounts_email_idx',
    ])
    expect(list({ q: 'email', kinds: ['column'] }).total).toBe(1)
    expect(list({ kinds: [] }).total).toBe(document.entries.length)
  })

  it('pages with a cursor, once through the list and without a repeat', () => {
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = list({}, { limit: 5, ...(cursor === undefined ? {} : { cursor }) })
      expect(page.total).toBe(document.entries.length)
      expect(page.items.length).toBeLessThanOrEqual(5)
      seen.push(...labels(page.items))
      cursor = page.nextCursor ?? undefined
      pages++
    } while (cursor !== undefined)
    expect(pages).toBe(Math.ceil(document.entries.length / 5))
    expect(seen).toEqual(labels(list().items))
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('refuses a cursor from another snapshot, other filters or a stranger', () => {
    const first = list({ kinds: ['table'] }, { limit: 1 })
    expect(first.nextCursor).not.toBeNull()
    const cursor = first.nextCursor ?? ''
    expect(cursor).toMatch(/^[A-Za-z0-9_-]{1,512}$/)
    // Same snapshot, same filters: continues.
    expect(list({ kinds: ['table'] }, { limit: 1, cursor }).items).toHaveLength(1)
    // The schema changed between the pages: a different fingerprint.
    const changed = makeDocument(header, [...document.entries, table('added')])
    expect(() => list({ kinds: ['table'] }, { limit: 1, cursor }, current(changed))).toThrow(
      expect.objectContaining({ code: 'SCHEMA_FINGERPRINT_MISMATCH' }),
    )
    // Other filters.
    expect(() => list({ kinds: ['view'] }, { limit: 1, cursor })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    )
    // Not a cursor of this list: the search's, garbage, a changed payload.
    for (const bad of [
      'd1_MQ',
      'r1_abc',
      'd2_',
      'd2_!!',
      `d2_${Buffer.from('[1,2,3]').toString('base64url')}`,
    ]) {
      expect(() => list({}, { limit: 1, cursor: bad }), bad).toThrow(
        expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      )
    }
  })

  it('says when the snapshot is incomplete and never invents the time', () => {
    const view = list(
      {},
      { limit: 1 },
      { ...current(), snapshot: { ...current().snapshot, complete: false } },
    )
    expect(view.complete).toBe(false)
    expect(view.observedAt).toBe('2026-10-20T10:00:00.000000Z')
  })
})

describe('the drift check history entry', () => {
  const record = (over: Partial<DriftCheckRecord> = {}): DriftCheckRecord => ({
    checkId: 'smp_01M48WRFNFYAY62E1146CHK001',
    targetId: 'tgt_01M48WRFNFYAY62E1146TGT001',
    generation: 2,
    requestedBy: 'schedule',
    status: 'drifted',
    baselineFingerprint: `fp1:17:${'a'.repeat(64)}`,
    currentFingerprint: `fp1:17:${'b'.repeat(64)}`,
    snapshotId: 'smp_01M48WRFNFYAY62E1146SMP001',
    drifted: 3,
    matched: 40,
    unmanaged: 1,
    opened: 2,
    updated: 1,
    resolved: 0,
    errorCode: null,
    startedAt: '2026-10-20T10:00:00.000000Z',
    finishedAt: '2026-10-20T10:00:02.500000Z',
    ...over,
  })

  it('names the schedule or the identity that asked, and carries every stored count', () => {
    expect(driftCheckSummaryView(record())).toEqual({
      id: 'smp_01M48WRFNFYAY62E1146CHK001',
      targetId: 'tgt_01M48WRFNFYAY62E1146TGT001',
      generation: 2,
      requestedBy: { kind: 'schedule' },
      status: 'drifted',
      baselineFingerprint: `fp1:17:${'a'.repeat(64)}`,
      currentFingerprint: `fp1:17:${'b'.repeat(64)}`,
      counts: { drifted: 3, matched: 40, unmanaged: 1, opened: 2, updated: 1, resolved: 0 },
      errorCode: null,
      startedAt: '2026-10-20T10:00:00.000000Z',
      finishedAt: '2026-10-20T10:00:02.500000Z',
    })
    expect(
      driftCheckSummaryView(record({ requestedBy: 'idn_01M48WRFNFYAY62E1146JDN001' })).requestedBy,
    ).toEqual({ kind: 'identity', identityId: 'idn_01M48WRFNFYAY62E1146JDN001' })
  })

  it('shows a failed check with its error code and no fingerprint it never had', () => {
    const failed = driftCheckSummaryView(
      record({
        status: 'failed',
        errorCode: 'TARGET_UNAVAILABLE',
        baselineFingerprint: null,
        currentFingerprint: null,
        drifted: 0,
        matched: 0,
        unmanaged: 0,
        opened: 0,
        updated: 0,
        resolved: 0,
      }),
    )
    expect(failed).toMatchObject({
      status: 'failed',
      errorCode: 'TARGET_UNAVAILABLE',
      baselineFingerprint: null,
      currentFingerprint: null,
    })
  })
})

describe('bounded untrusted text', () => {
  it('never cuts a surrogate pair in half (PostgreSQL refuses it in JSON)', () => {
    const emoji = '\u{1F600}'
    for (let max = 2; max <= 12; max++) {
      const out = clip(`a${emoji.repeat(10)}`, max)
      expect(out.isWellFormed()).toBe(true)
      expect(out.length).toBeLessThanOrEqual(max)
      expect(out.endsWith('…')).toBe(true)
    }
    expect(clip('short', 10)).toBe('short')
  })
})
