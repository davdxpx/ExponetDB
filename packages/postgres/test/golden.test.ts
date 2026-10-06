import { describe, expect, it } from 'vitest'
import {
  type CanonicalDocument,
  diffDocuments,
  documentFromJson,
  documentJson,
  fingerprintOf,
  securityRelevant,
} from '../src/index.ts'
import { diffVectors, fp1Vectors } from './golden.ts'

/**
 * The fp1 golden vectors without a database (order §227 to §229): every
 * stored document parses with its entry hashes rechecked, reproduces its
 * fingerprint, and serializes back to exactly the vector; every diff vector
 * is reproduced by `diffDocuments` and `securityRelevant`. The integration
 * test (`golden.int.test.ts`) proves the documents come out of real
 * PostgreSQL 16, 17 and 18.
 */
const vectors = fp1Vectors()
const documents = new Map<string, CanonicalDocument>()
for (const v of vectors) {
  const parsed = documentFromJson(v.expected.document)
  if (parsed === undefined) throw new Error(`${v.id}: the stored document does not parse`)
  documents.set(v.id, parsed)
}

describe('fp1 golden vectors', () => {
  it('cover minimal, complex, security and hostile schemas on PostgreSQL 16, 17 and 18', () => {
    const majors = new Set(vectors.map((v) => v.input.pgMajor))
    expect([...majors].sort()).toEqual([16, 17, 18])
    for (const fixture of ['minimal', 'complex', 'security', 'hostile']) {
      for (const major of [16, 17, 18]) {
        expect(
          vectors.some((v) => v.description.startsWith(`${fixture}, PostgreSQL ${major}:`)),
          `${fixture} ${major}`,
        ).toBe(true)
      }
    }
  })

  it.each(vectors.map((v) => [v.id, v] as const))(
    '%s: hashes, fingerprint and serialization reproduce',
    (_id, v) => {
      const document = documents.get(v.id) as CanonicalDocument
      expect(document.entries).toHaveLength(v.expected.entryCount)
      expect(document.header.pgMajor).toBe(v.input.pgMajor)
      expect(fingerprintOf(document)).toBe(v.expected.fingerprint)
      expect(documentJson(document)).toEqual(v.expected.document)
    },
  )

  it('refuses a stored document whose attributes were changed', () => {
    const v = vectors[0]
    if (v === undefined) throw new Error('no vector')
    const tampered = structuredClone(v.expected.document) as {
      entries: { attributes: Record<string, unknown> }[]
    }
    const first = tampered.entries[0]
    if (first === undefined) throw new Error('no entry')
    first.attributes['position'] = 99
    expect(documentFromJson(tampered as never)).toBeUndefined()
  })

  it('keeps the PUBLIC pseudo-role apart from a role named "PUBLIC"', () => {
    const security = vectors.find((v) => v.description.startsWith('security, PostgreSQL 17:'))
    const document = documents.get(security?.id ?? '') as CanonicalDocument
    const policy = (name: string) =>
      document.entries.find((e) => e.class === 'policy' && e.key[2] === name)?.attributes['roles']
    expect(policy('has_body')).toEqual([null])
    expect(policy('quoted_public')).toEqual(['PUBLIC'])
    const table = document.entries.find((e) => e.class === 'table' && e.key[1] === 'documents')
    const acl = table?.attributes['acl'] as { to?: string; privilege: string }[]
    expect(acl.filter((a) => a.to === undefined).map((a) => a.privilege)).toEqual(['SELECT'])
    expect(acl.filter((a) => a.to === 'PUBLIC').map((a) => a.privilege)).toEqual(['INSERT'])
  })
})

describe('schema-diff golden vectors', () => {
  const ref = (entry: { class: string; key: readonly string[] }) => ({
    class: entry.class,
    key: [...entry.key],
  })

  it.each(diffVectors().map((v) => [v.id, v] as const))('%s reproduces', (_id, v) => {
    const left = documents.get(v.input.left)
    const right = documents.get(v.input.right)
    if (left === undefined || right === undefined) throw new Error(`${v.id}: unknown document`)
    const diff = diffDocuments(left, right)
    expect({
      comparable: diff.comparable,
      added: diff.added.map((entry) => ({
        ...ref(entry),
        securityRelevant: securityRelevant({ kind: 'added', entry }),
      })),
      removed: diff.removed.map((entry) => ({
        ...ref(entry),
        securityRelevant: securityRelevant({ kind: 'removed', entry }),
      })),
      changed: diff.changed.map((change) => ({
        ...ref(change),
        attributes: [...change.attributes],
        securityRelevant: securityRelevant({ kind: 'changed', change }),
      })),
      documentationChanged: diff.documentationChanged.map((e) => [e.class, [...e.key]]),
      matched: diff.matched,
    }).toEqual(v.expected)
  })
})
