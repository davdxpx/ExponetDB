import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalize, isJsonArray, isJsonObject, parseJson } from '@exponetdb/kernel'
import { sha256Hex } from '@exponetdb/kernel/hash'

/**
 * Golden vectors are append-only once G1 is accepted (package-architecture.md
 * §1.1). LOCK.json records sha256(JCS(vector)) for every vector id.
 *
 *   bun run golden:check   fail when a locked vector changed or disappeared,
 *                          when an id is duplicated, or when a vector is not
 *                          locked yet
 *   bun run golden:lock    append the hashes of new vectors; never rewrites
 *                          an existing entry
 */
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'golden')
const LOCK = join(dir, 'LOCK.json')
type Lock = Record<string, Record<string, string>>

function vectorHashes(file: string): Map<string, string> {
  const parsed = parseJson(readFileSync(join(dir, file), 'utf8'))
  if (!parsed.ok) {
    throw new Error(`${file}: ${parsed.error.code}`)
  }
  const doc = parsed.value
  const vectors = isJsonObject(doc) ? doc['vectors'] : undefined
  if (!isJsonArray(vectors)) {
    throw new Error(`${file}: no vectors array`)
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
    const canonical = canonicalize(v)
    if (!canonical.ok) {
      throw new Error(`${file}/${id}: ${canonical.error.code}`)
    }
    out.set(id, sha256Hex(canonical.value))
  }
  return out
}

const files = readdirSync(dir)
  .filter((f) => f.endsWith('.json') && f !== 'LOCK.json')
  .sort()
/** Reads LOCK.json. Only a missing file is an empty lock; a damaged one fails closed. */
function readLock(): Lock {
  if (!existsSync(LOCK)) {
    return {}
  }
  const parsed = parseJson(readFileSync(LOCK, 'utf8'))
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

const lock = readLock()

const problems: string[] = []
const appended: string[] = []
for (const file of files) {
  const current = vectorHashes(file)
  const locked = lock[file] ?? {}
  for (const [id, hash] of Object.entries(locked)) {
    const now = current.get(id)
    if (now === undefined) {
      problems.push(`${file}: locked vector ${id} was removed (vectors are append-only)`)
    } else if (now !== hash) {
      problems.push(
        `${file}: locked vector ${id} was changed (vectors are append-only; a new canonicalizer needs an ADR)`,
      )
    }
  }
  for (const [id, hash] of current) {
    if (locked[id] === undefined) {
      appended.push(`${file}: ${id}`)
      locked[id] = hash
    }
  }
  lock[file] = locked
}
for (const file of Object.keys(lock)) {
  if (!files.includes(file)) {
    problems.push(`${file}: a locked vector file was removed`)
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
if (process.argv.includes('--append')) {
  const sorted: Lock = {}
  for (const file of Object.keys(lock).sort()) {
    sorted[file] = Object.fromEntries(
      Object.entries(lock[file] ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)),
    )
  }
  writeFileSync(LOCK, `${JSON.stringify(sorted, null, 2)}\n`)
  console.log(`locked ${appended.length} new vectors`)
} else if (appended.length > 0) {
  console.error(
    `${appended.length} vectors are not locked yet; run \`bun run golden:lock\`:\n${appended.join('\n')}`,
  )
  process.exit(1)
} else {
  console.log(`golden vectors intact (${files.length} files, all locked)`)
}
