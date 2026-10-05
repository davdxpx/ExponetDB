import { canonicalize, isJsonArray, isJsonObject, parseJson } from '@exponetdb/kernel'
import { sha256Hex } from '@exponetdb/kernel/hash'

/**
 * Parsing shared by the two golden-vector guards:
 *
 * - `golden-lock.ts` (`bun run golden:check`): the current tree is internally
 *   consistent (every vector locked, every lock entry matches its vector);
 * - `golden-history.ts` (`bun run golden:history <base>`): nothing that existed
 *   in a base commit was changed or removed.
 *
 * Pure functions over text, so both guards and their tests read vectors the
 * same way. Every refusal throws: a guard that cannot read its input fails
 * closed.
 */
export const LOCK_FILE = 'LOCK.json'

/** File name → vector id → lowercase hex sha256(JCS(vector)). */
export type Lock = Record<string, Record<string, string>>

export interface GoldenFile {
  /** Top-level members other than `vectors`, as canonical (RFC 8785) JSON text. */
  readonly metadata: ReadonlyMap<string, string>
  /** Vector id → canonical JSON text of the whole vector, in file order. */
  readonly vectors: ReadonlyMap<string, string>
}

/** Vector files are the `.json` files of the golden directory except the lock. */
export function isVectorFile(name: string): boolean {
  return name.endsWith('.json') && name !== LOCK_FILE
}

/** The lock hash of a vector: sha256 over its canonical JSON text. */
export function lockHash(canonicalVector: string): string {
  return sha256Hex(canonicalVector)
}

/** Parses one vector file strictly: an object with a `vectors` array of objects with unique string ids. */
export function parseGoldenFile(file: string, text: string): GoldenFile {
  const parsed = parseJson(text)
  if (!parsed.ok) {
    throw new Error(`${file}: ${parsed.error.code}`)
  }
  const doc = parsed.value
  if (!isJsonObject(doc)) {
    throw new Error(`${file}: not a JSON object`)
  }
  const vectors = doc['vectors']
  if (!isJsonArray(vectors)) {
    throw new Error(`${file}: no vectors array`)
  }
  const metadata = new Map<string, string>()
  for (const [name, value] of Object.entries(doc)) {
    if (name !== 'vectors') {
      metadata.set(name, canonicalText(`${file}/${name}`, value))
    }
  }
  const out = new Map<string, string>()
  for (const v of vectors) {
    const id = isJsonObject(v) ? v['id'] : undefined
    if (typeof id !== 'string') {
      throw new Error(`${file}: vector without id`)
    }
    if (out.has(id)) {
      throw new Error(`${file}: duplicate vector id ${id}`)
    }
    out.set(id, canonicalText(`${file}/${id}`, v))
  }
  return { metadata, vectors: out }
}

function canonicalText(where: string, value: unknown): string {
  const canonical = canonicalize(value)
  if (!canonical.ok) {
    throw new Error(`${where}: ${canonical.error.code}`)
  }
  return canonical.value
}

/** Parses LOCK.json strictly. A damaged lock is an error, never an empty lock. */
export function parseLock(text: string): Lock {
  const parsed = parseJson(text)
  if (!parsed.ok || !isJsonObject(parsed.value)) {
    throw new Error('LOCK.json is not a JSON object')
  }
  const lock: Lock = {}
  for (const [file, entries] of Object.entries(parsed.value)) {
    if (!isJsonObject(entries)) {
      throw new Error(`LOCK.json: ${file} is not an object`)
    }
    const hashes: Record<string, string> = {}
    for (const [id, hash] of Object.entries(entries)) {
      if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
        throw new Error(`LOCK.json: ${file}/${id} is not a SHA-256 hex digest`)
      }
      hashes[id] = hash
    }
    lock[file] = hashes
  }
  return lock
}
