import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalize, decodeUtf8, isJsonArray, isJsonObject, parseJson } from '@exponetdb/kernel'
import {
  type GoldenFile,
  isVectorFile,
  LOCK_FILE,
  type Lock,
  lockHash,
  parseGoldenFile,
  parseLock,
} from './golden-data.ts'

/**
 * Golden history guard (G1 freeze, enforced from Wave 2 on).
 *
 *   bun run golden:history <base-ref>
 *
 * `golden:check` proves that the current tree is consistent. It cannot see a
 * change that edits a locked vector, its expected value and its LOCK.json
 * entry together. This guard compares the current tree with a base commit and
 * refuses every change to history:
 *
 * - every vector file of the base still exists;
 * - every base vector id still exists and its vector is canonically (RFC 8785)
 *   identical: no redefinition, no edited expected value, no removal;
 * - every top-level member of a base file other than `vectors` (contract,
 *   specification, notes) is canonically identical, and none is added or
 *   removed;
 * - every LOCK.json entry of the base still exists with the same hash;
 * - every vector that is new relative to the base has a LOCK.json entry equal
 *   to sha256(JCS(vector)); new vector files are allowed on the same terms.
 *
 * It also guards the frozen Control Store bundles (G2 and G3A acceptances):
 *
 * - every entry of the base's `packages/control-store/frozen-bundles.json`
 *   still exists, canonically identical; the file's other members too;
 * - the directory `<id>_<name>` of every bundle listed at the base has
 *   exactly the files of the base, byte for byte (no edit, not even of a
 *   comment; no added or removed file);
 * - an entry that is new relative to the base names an existing bundle.
 *
 * There is deliberately no option to accept a new baseline, rewrite or update
 * an existing entry, or skip the check. A base ref that is missing or cannot
 * be read fails closed. A stored contract that must change gets a new version
 * (c2, ls2, a new plan-hash prefix through an ADR) with new vectors; a frozen
 * bundle never changes, a schema change is a new bundle.
 */
const GOLDEN_DIR = 'tooling/golden'
export const FROZEN_LIST = 'packages/control-store/frozen-bundles.json'
export const BUNDLE_DIR = 'packages/control-store/migrations'
const ZERO_SHA = /^0+$/

export interface HistorySummary {
  readonly baseCommit: string
  readonly baseFiles: number
  readonly baseVectors: number
  readonly newFiles: number
  readonly newVectors: number
  /** Bundles frozen at the base whose files are unchanged. */
  readonly frozenBundles: number
  /** Bundles frozen by this change (new entries of the list). */
  readonly newFrozenBundles: number
}

export type HistoryResult =
  | { readonly ok: true; readonly summary: HistorySummary }
  | { readonly ok: false; readonly problems: readonly string[] }

function git(repoDir: string, args: readonly string[]): Buffer {
  return execFileSync('git', ['-C', repoDir, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  })
}

function decode(where: string, bytes: Uint8Array): string {
  const text = decodeUtf8(bytes)
  if (!text.ok) {
    throw new Error(`${where}: not valid UTF-8`)
  }
  return text.value
}

/** A ref the guard is willing to pass to git: printable ASCII, no leading dash, no whitespace. */
function isAcceptableRef(ref: string): boolean {
  return ref.length > 0 && ref.length <= 256 && !ref.startsWith('-') && /^[\x21-\x7e]+$/.test(ref)
}

function resolveBase(repoDir: string, ref: string): string | undefined {
  if (!isAcceptableRef(ref) || ZERO_SHA.test(ref)) {
    return undefined
  }
  try {
    const sha = decode(
      'git rev-parse',
      git(repoDir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]),
    ).trim()
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined
  } catch {
    return undefined
  }
}

function baseFileNames(repoDir: string, commit: string): string[] {
  const listing = decode(
    'git ls-tree',
    git(repoDir, ['ls-tree', '-z', '--name-only', commit, '--', `${GOLDEN_DIR}/`]),
  )
  return listing
    .split('\0')
    .filter((p) => p.length > 0)
    .map((p) => p.slice(GOLDEN_DIR.length + 1))
}

function baseText(repoDir: string, commit: string, file: string): string {
  return decode(
    `${file} at the base`,
    git(repoDir, ['cat-file', 'blob', `${commit}:${GOLDEN_DIR}/${file}`]),
  )
}

function headText(repoDir: string, file: string): string | undefined {
  const path = join(repoDir, GOLDEN_DIR, file)
  if (!existsSync(path)) {
    return undefined
  }
  return decode(file, readFileSync(path))
}

function compareMetadata(
  file: string,
  base: GoldenFile,
  head: GoldenFile,
  problems: string[],
): void {
  for (const [name, value] of base.metadata) {
    const now = head.metadata.get(name)
    if (now === undefined) {
      problems.push(`${file}: file member "${name}" was removed (golden history is immutable)`)
    } else if (now !== value) {
      problems.push(`${file}: file member "${name}" was changed (golden history is immutable)`)
    }
  }
  for (const name of head.metadata.keys()) {
    if (!base.metadata.has(name)) {
      problems.push(`${file}: file member "${name}" was added to an existing vector file`)
    }
  }
}

interface FrozenList {
  /** Top-level members other than `bundles`, as canonical JSON text. */
  readonly metadata: ReadonlyMap<string, string>
  /** Bundle id → canonical JSON text of the entry. */
  readonly entries: ReadonlyMap<string, string>
  /** Bundle id → `<id>_<name>` directory name. */
  readonly dirs: ReadonlyMap<string, string>
}

const BUNDLE_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/
const BUNDLE_NAME = /^[a-z][a-z0-9-]{0,62}$/

/** Parses the frozen-bundle list strictly; every refusal throws (the guard fails closed). */
export function parseFrozenList(where: string, text: string): FrozenList {
  const parsed = parseJson(text)
  if (!parsed.ok || !isJsonObject(parsed.value)) {
    throw new Error(`${where}: not a JSON object`)
  }
  const doc = parsed.value
  const bundles = doc['bundles']
  if (!isJsonArray(bundles)) {
    throw new Error(`${where}: no bundles array`)
  }
  const metadata = new Map<string, string>()
  for (const [name, value] of Object.entries(doc)) {
    if (name !== 'bundles') {
      metadata.set(name, canonicalText(`${where}/${name}`, value))
    }
  }
  const entries = new Map<string, string>()
  const dirs = new Map<string, string>()
  for (const entry of bundles) {
    const id = isJsonObject(entry) ? entry['id'] : undefined
    const name = isJsonObject(entry) ? entry['name'] : undefined
    if (typeof id !== 'string' || !BUNDLE_ID.test(id)) {
      throw new Error(`${where}: an entry has no bundle id`)
    }
    if (typeof name !== 'string' || !BUNDLE_NAME.test(name)) {
      throw new Error(`${where}: entry ${id} has no bundle name`)
    }
    if (entries.has(id)) {
      throw new Error(`${where}: duplicate entry ${id}`)
    }
    entries.set(id, canonicalText(`${where}/${id}`, entry))
    dirs.set(id, `${id}_${name}`)
  }
  return { metadata, entries, dirs }
}

function canonicalText(where: string, value: unknown): string {
  const canonical = canonicalize(value)
  if (!canonical.ok) {
    throw new Error(`${where}: ${canonical.error.code}`)
  }
  return canonical.value
}

function baseHas(repoDir: string, commit: string, path: string): boolean {
  try {
    git(repoDir, ['cat-file', '-e', `${commit}:${path}`])
    return true
  } catch {
    return false
  }
}

/** Relative path → blob id of every file below `dir` at the base commit. */
function baseTree(repoDir: string, commit: string, dir: string): Map<string, string> {
  const listing = decode(
    'git ls-tree',
    git(repoDir, ['ls-tree', '-r', '-z', '--full-tree', commit, '--', `${dir}/`]),
  )
  const out = new Map<string, string>()
  for (const line of listing.split('\0')) {
    if (line.length === 0) {
      continue
    }
    const tab = line.indexOf('\t')
    const [, type, blob] = line.slice(0, tab).split(' ')
    if (type !== 'blob' || blob === undefined) {
      throw new Error(`${dir} at the base holds something other than files`)
    }
    out.set(line.slice(tab + 1).slice(dir.length + 1), blob)
  }
  return out
}

function headTree(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) {
        walk(path)
      } else {
        out.push(relative(root, path).split(sep).join('/'))
      }
    }
  }
  walk(root)
  return out
}

function checkFrozenBundles(
  repoDir: string,
  commit: string,
  problems: string[],
): { readonly frozenBundles: number; readonly newFrozenBundles: number } {
  const headText = existsSync(join(repoDir, FROZEN_LIST))
    ? decode(FROZEN_LIST, readFileSync(join(repoDir, FROZEN_LIST)))
    : undefined
  let base: FrozenList | undefined
  if (baseHas(repoDir, commit, FROZEN_LIST)) {
    base = parseFrozenList(
      `${FROZEN_LIST} at the base`,
      decode(FROZEN_LIST, git(repoDir, ['cat-file', 'blob', `${commit}:${FROZEN_LIST}`])),
    )
  }
  if (headText === undefined) {
    if (base !== undefined) {
      problems.push(`${FROZEN_LIST} was removed (frozen bundles are permanent)`)
    }
    return { frozenBundles: 0, newFrozenBundles: 0 }
  }
  let head: FrozenList
  try {
    head = parseFrozenList(FROZEN_LIST, headText)
  } catch (error) {
    problems.push(error instanceof Error ? error.message : `${FROZEN_LIST} is unreadable`)
    return { frozenBundles: 0, newFrozenBundles: 0 }
  }
  let frozenBundles = 0
  if (base !== undefined) {
    for (const [name, value] of base.metadata) {
      if (head.metadata.get(name) !== value) {
        problems.push(`${FROZEN_LIST}: member "${name}" of the base was changed or removed`)
      }
    }
    for (const [id, entry] of base.entries) {
      const now = head.entries.get(id)
      if (now === undefined) {
        problems.push(`${FROZEN_LIST}: frozen bundle ${id} of the base was removed`)
      } else if (now !== entry) {
        problems.push(`${FROZEN_LIST}: entry of frozen bundle ${id} was changed`)
      }
      const dir = `${BUNDLE_DIR}/${base.dirs.get(id) ?? id}`
      const before = baseTree(repoDir, commit, dir)
      if (before.size === 0) {
        problems.push(`${dir}: listed as frozen at the base but absent there; failing closed`)
        continue
      }
      const root = join(repoDir, dir)
      const after = existsSync(root) ? headTree(root) : []
      const changed: string[] = []
      for (const [file, blob] of before) {
        const path = join(root, file)
        if (!existsSync(path)) {
          changed.push(`${file} removed`)
          continue
        }
        const baseBytes = git(repoDir, ['cat-file', 'blob', blob])
        if (!baseBytes.equals(readFileSync(path))) {
          changed.push(`${file} changed`)
        }
      }
      for (const file of after) {
        if (!before.has(file)) {
          changed.push(`${file} added`)
        }
      }
      if (changed.length > 0) {
        problems.push(
          `${dir}: a frozen bundle was edited (${changed.join(', ')}); a schema change is a new bundle`,
        )
      } else {
        frozenBundles += 1
      }
    }
  }
  let newFrozenBundles = 0
  for (const [id, dirName] of head.dirs) {
    if (base?.entries.has(id) === true) {
      continue
    }
    newFrozenBundles += 1
    if (!existsSync(join(repoDir, BUNDLE_DIR, dirName))) {
      problems.push(`${FROZEN_LIST}: new entry ${id} names no bundle directory ${dirName}`)
    }
  }
  return { frozenBundles, newFrozenBundles }
}

/** Compares the working tree of `repoDir` with `baseRef`. Never modifies anything. */
export function checkGoldenHistory(repoDir: string, baseRef: string): HistoryResult {
  const commit = resolveBase(repoDir, baseRef)
  if (commit === undefined) {
    return {
      ok: false,
      problems: [
        `base ref "${isAcceptableRef(baseRef) ? baseRef : '<refused>'}" cannot be read as a commit; the history check fails closed`,
      ],
    }
  }
  const problems: string[] = []
  let baseNames: string[]
  let baseLock: Lock | undefined
  const baseFiles = new Map<string, GoldenFile>()
  try {
    baseNames = baseFileNames(repoDir, commit)
    for (const name of baseNames.filter(isVectorFile)) {
      baseFiles.set(name, parseGoldenFile(name, baseText(repoDir, commit, name)))
    }
    if (baseNames.includes(LOCK_FILE)) {
      baseLock = parseLock(baseText(repoDir, commit, LOCK_FILE))
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unreadable'
    return { ok: false, problems: [`base ${commit}: ${reason}; the history check fails closed`] }
  }
  if (baseFiles.size > 0 && baseLock === undefined) {
    return {
      ok: false,
      problems: [
        `base ${commit} has golden vectors but no ${LOCK_FILE}; the history check fails closed`,
      ],
    }
  }

  const headDir = join(repoDir, GOLDEN_DIR)
  const headNames = existsSync(headDir) ? readdirSync(headDir).filter(isVectorFile).sort() : []
  let headLock: Lock = {}
  const lockText = headText(repoDir, LOCK_FILE)
  if (lockText === undefined) {
    if (baseLock !== undefined || headNames.length > 0) {
      problems.push(`${LOCK_FILE} was removed`)
    }
  } else {
    try {
      headLock = parseLock(lockText)
    } catch (error) {
      problems.push(error instanceof Error ? error.message : `${LOCK_FILE} is unreadable`)
    }
  }

  let baseVectors = 0
  let newVectors = 0
  let newFiles = 0
  const headFiles = new Map<string, GoldenFile>()
  for (const name of headNames) {
    const text = headText(repoDir, name)
    if (text === undefined) {
      continue
    }
    try {
      headFiles.set(name, parseGoldenFile(name, text))
    } catch (error) {
      problems.push(error instanceof Error ? error.message : `${name} is unreadable`)
    }
  }

  for (const [name, base] of baseFiles) {
    baseVectors += base.vectors.size
    const head = headFiles.get(name)
    if (head === undefined) {
      if (!headNames.includes(name)) {
        problems.push(
          `${name}: a vector file of the base was removed (golden history is immutable)`,
        )
      }
      continue
    }
    compareMetadata(name, base, head, problems)
    for (const [id, vector] of base.vectors) {
      const now = head.vectors.get(id)
      if (now === undefined) {
        problems.push(`${name}: vector ${id} of the base was removed (vectors are append-only)`)
      } else if (now !== vector) {
        problems.push(
          `${name}: vector ${id} of the base was changed (frozen; a changed contract is a new version through an ADR)`,
        )
      }
    }
  }

  for (const [file, entries] of Object.entries(baseLock ?? {})) {
    for (const [id, hash] of Object.entries(entries)) {
      const now = headLock[file]?.[id]
      if (now === undefined) {
        problems.push(`${LOCK_FILE}: entry ${file}/${id} of the base was removed`)
      } else if (now !== hash) {
        problems.push(`${LOCK_FILE}: entry ${file}/${id} of the base was changed`)
      }
    }
  }

  for (const [name, head] of headFiles) {
    const base = baseFiles.get(name)
    if (base === undefined) {
      newFiles += 1
    }
    for (const [id, vector] of head.vectors) {
      if (base?.vectors.has(id) === true) {
        continue
      }
      newVectors += 1
      const locked = headLock[name]?.[id]
      if (locked === undefined) {
        problems.push(
          `${name}: new vector ${id} has no ${LOCK_FILE} entry (run \`bun run golden:lock\`)`,
        )
      } else if (locked !== lockHash(vector)) {
        problems.push(`${name}: ${LOCK_FILE} entry of new vector ${id} does not match the vector`)
      }
    }
  }

  let frozen = { frozenBundles: 0, newFrozenBundles: 0 }
  try {
    frozen = checkFrozenBundles(repoDir, commit, problems)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unreadable'
    problems.push(`frozen bundles: ${reason}; the history check fails closed`)
  }

  if (problems.length > 0) {
    return { ok: false, problems }
  }
  return {
    ok: true,
    summary: {
      baseCommit: commit,
      baseFiles: baseFiles.size,
      baseVectors,
      newFiles,
      newVectors,
      ...frozen,
    },
  }
}

export type ParsedArgs =
  | { readonly ok: true; readonly base: string }
  | { readonly ok: false; readonly message: string }

/**
 * Accepts exactly one base: `<ref>` or `--base <ref>` / `--base=<ref>`. Any
 * other option is refused, so a rebaseline or skip switch cannot be invented
 * on the command line.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const bases: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '--base') {
      const next = argv[i + 1]
      if (next === undefined) {
        return { ok: false, message: '--base needs a git ref' }
      }
      bases.push(next)
      i += 1
    } else if (arg.startsWith('--base=')) {
      bases.push(arg.slice('--base='.length))
    } else if (arg.startsWith('-')) {
      return {
        ok: false,
        message: `unknown option ${arg}: the history check has no options besides --base`,
      }
    } else {
      bases.push(arg)
    }
  }
  if (bases.length !== 1 || (bases[0] ?? '').length === 0) {
    return {
      ok: false,
      message: 'exactly one base git ref is required (the check fails closed without one)',
    }
  }
  return { ok: true, base: bases[0] ?? '' }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2))
  if (!args.ok) {
    console.error(`golden:history: ${args.message}`)
    process.exit(2)
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const result = checkGoldenHistory(root, args.base)
  if (!result.ok) {
    console.error(result.problems.join('\n'))
    process.exit(1)
  }
  const s = result.summary
  console.log(
    `golden history intact against ${s.baseCommit.slice(0, 12)}: ${s.baseVectors} vectors in ${s.baseFiles} files unchanged; ${s.newVectors} new vectors (${s.newFiles} new files), all locked; ${s.frozenBundles} frozen Control Store bundles byte-identical, ${s.newFrozenBundles} newly frozen`,
  )
}
