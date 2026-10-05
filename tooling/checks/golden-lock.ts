import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isVectorFile,
  LOCK_FILE,
  type Lock,
  lockHash,
  parseGoldenFile,
  parseLock,
} from './golden-data.ts'

/**
 * Golden vectors are append-only since the owner accepted G1 (2026-10-05)
 * (package-architecture.md §1.1). LOCK.json records sha256(JCS(vector)) for
 * every vector id.
 *
 *   bun run golden:check   current-tree consistency: fail when a locked vector
 *                          changed or disappeared, when an id is duplicated,
 *                          or when a vector is not locked yet
 *   bun run golden:lock    append the hashes of new vectors; never rewrites
 *                          an existing entry
 *
 * This check only sees the current tree: a change that edits a vector and its
 * lock entry together is consistent here. `bun run golden:history <base>`
 * (golden-history.ts) compares against a base commit and refuses it.
 */
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'golden')
const LOCK = join(dir, LOCK_FILE)

function vectorHashes(file: string): Map<string, string> {
  const parsed = parseGoldenFile(file, readFileSync(join(dir, file), 'utf8'))
  const out = new Map<string, string>()
  for (const [id, canonical] of parsed.vectors) {
    out.set(id, lockHash(canonical))
  }
  return out
}

const files = readdirSync(dir).filter(isVectorFile).sort()

/** Reads LOCK.json. Only a missing file is an empty lock; a damaged one fails closed. */
function readLock(): Lock {
  if (!existsSync(LOCK)) {
    return {}
  }
  return parseLock(readFileSync(LOCK, 'utf8'))
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
