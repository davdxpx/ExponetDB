import { diffDocuments, makeDocument, makeEntry, scopeHeader } from '@exponetdb/postgres'
import { describe, expect, it } from 'vitest'
import {
  capDriftItems,
  clip,
  dedupKeyOf,
  driftItems,
  encodeDocument,
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
