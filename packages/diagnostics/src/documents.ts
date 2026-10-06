import { gunzipSync, gzipSync } from 'node:zlib'
import type { Queryable } from '@exponetdb/control-store'
import { canonicalize, InvariantError, parseJson } from '@exponetdb/kernel'
import { sha256Hex } from '@exponetdb/kernel/hash'
import {
  type CanonicalDocument,
  documentFromJson,
  documentJson,
  fingerprintOf,
} from '@exponetdb/postgres'
import { DocumentCorrupt } from './errors.ts'

/**
 * Canonical schema documents in the Control Store ([schema-fingerprints.md §9](../../../exponetdb-docs/03-database-model/schema-fingerprints.md)):
 * one row per fingerprint, written once, never changed. The stored bytes
 * are the gzip of the document's RFC 8785 (JCS) form; compression is
 * storage only and never part of the fingerprint. The digest is SHA-256
 * over the uncompressed bytes and `content_bytes` their length.
 *
 * A document is used only after it verifies on read: the inflated length
 * may not exceed `content_bytes` (nothing larger is ever inflated), the
 * digest must match, every entry hash is recomputed (`documentFromJson`)
 * and the recomputed fingerprint must be the row's key. A document that
 * fails any check is never used.
 *
 * Comments are not structure (§5): two snapshots with the same fingerprint
 * may differ in their documentation digests; the first one stored is kept.
 */
export const DOCUMENT_ENCODING = 'gzip'

export interface StoredDocument {
  readonly fingerprint: string
  readonly entries: number
  readonly contentBytes: number
  readonly documentDigest: string
  /** false when a document with this fingerprint was already stored. */
  readonly inserted: boolean
}

export function encodeDocument(document: CanonicalDocument): {
  readonly bytes: Buffer
  readonly digest: string
} {
  const text = canonicalize(documentJson(document))
  if (!text.ok) {
    throw new InvariantError('a canonical document is I-JSON')
  }
  const bytes = Buffer.from(text.value, 'utf8')
  return { bytes, digest: `sha256:${sha256Hex(bytes)}` }
}

export async function storeDocument(
  q: Queryable,
  document: CanonicalDocument,
): Promise<StoredDocument> {
  const fingerprint = fingerprintOf(document)
  const { bytes, digest } = encodeDocument(document)
  const { rows } = await q.query(
    'observation.documents.insert',
    `INSERT INTO observation.schema_documents
       (fingerprint, canonicalizer, pg_major, entries, encoding, document, content_bytes, document_digest)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (fingerprint) DO NOTHING
     RETURNING fingerprint`,
    [
      fingerprint,
      document.header.canonicalizer,
      document.header.pgMajor,
      document.entries.length,
      DOCUMENT_ENCODING,
      gzipSync(bytes),
      bytes.length,
      digest,
    ],
  )
  return {
    fingerprint,
    entries: document.entries.length,
    contentBytes: bytes.length,
    documentDigest: digest,
    inserted: rows.length === 1,
  }
}

export interface DocumentHead {
  readonly fingerprint: string
  readonly canonicalizer: string
  readonly pgMajor: number
  readonly entries: number
  readonly contentBytes: number
  readonly documentDigest: string
}

export async function documentHead(
  q: Queryable,
  fingerprint: string,
): Promise<DocumentHead | undefined> {
  const { rows } = await q.query(
    'observation.documents.head',
    `SELECT fingerprint, canonicalizer, pg_major, entries, content_bytes, document_digest
       FROM observation.schema_documents WHERE fingerprint = $1`,
    [fingerprint],
  )
  const row = rows[0]
  return row === undefined
    ? undefined
    : {
        fingerprint: row.text('fingerprint'),
        canonicalizer: row.text('canonicalizer'),
        pgMajor: row.int('pg_major'),
        entries: row.int('entries'),
        contentBytes: row.int('content_bytes'),
        documentDigest: row.text('document_digest'),
      }
}

/** Loads and verifies a stored document; throws {@link DocumentCorrupt} when anything does not check out. */
export async function loadDocument(q: Queryable, fingerprint: string): Promise<CanonicalDocument> {
  const { rows } = await q.query(
    'observation.documents.load',
    `SELECT pg_major, entries, encoding, document, content_bytes, document_digest
       FROM observation.schema_documents WHERE fingerprint = $1`,
    [fingerprint],
  )
  const row = rows[0]
  if (row === undefined) {
    throw new DocumentCorrupt(fingerprint, 'missing')
  }
  if (row.text('encoding') !== DOCUMENT_ENCODING) {
    throw new DocumentCorrupt(fingerprint, 'encoding')
  }
  const expectedLength = row.int('content_bytes')
  let bytes: Buffer
  try {
    // Never inflate more than the recorded length (a stored bomb stops here).
    bytes = gunzipSync(row.bytes('document'), { maxOutputLength: expectedLength })
  } catch {
    throw new DocumentCorrupt(fingerprint, 'inflate')
  }
  if (bytes.length !== expectedLength) {
    throw new DocumentCorrupt(fingerprint, 'length')
  }
  if (`sha256:${sha256Hex(bytes)}` !== row.text('document_digest')) {
    throw new DocumentCorrupt(fingerprint, 'digest')
  }
  const parsed = parseJson(bytes.toString('utf8'))
  if (!parsed.ok) {
    throw new DocumentCorrupt(fingerprint, 'json')
  }
  const document = documentFromJson(parsed.value)
  if (document === undefined) {
    throw new DocumentCorrupt(fingerprint, 'entries')
  }
  if (
    document.entries.length !== row.int('entries') ||
    document.header.pgMajor !== row.int('pg_major')
  ) {
    throw new DocumentCorrupt(fingerprint, 'entries')
  }
  if (fingerprintOf(document) !== fingerprint) {
    throw new DocumentCorrupt(fingerprint, 'fingerprint')
  }
  return document
}
