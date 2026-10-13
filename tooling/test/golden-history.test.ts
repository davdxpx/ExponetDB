import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalize } from '@exponetdb/kernel'
import { afterEach, describe, expect, it } from 'vitest'
import { lockHash } from '../checks/golden-data.ts'
import { checkGoldenHistory, parseArgs } from '../checks/golden-history.ts'

/**
 * The history guard must refuse every change to locked history, including
 * the change `golden:check` cannot see (vector, expected value and lock entry
 * edited together). Each case builds a throwaway git repository: a base
 * commit, then an edited working tree.
 */
type Vector = { id: string } & Record<string, unknown>
interface GoldenDoc {
  contract: string
  specification: string
  vectors: Vector[]
}

const repos: string[] = []

afterEach(() => {
  for (const dir of repos.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
}

function hashOf(vector: Vector): string {
  const text = canonicalize(vector)
  if (!text.ok) {
    throw new Error('test vector is not JSON')
  }
  return lockHash(text.value)
}

function lockFor(files: Record<string, GoldenDoc>): Record<string, Record<string, string>> {
  const lock: Record<string, Record<string, string>> = {}
  for (const [name, doc] of Object.entries(files)) {
    lock[name] = Object.fromEntries(doc.vectors.map((v) => [v.id, hashOf(v)]))
  }
  return lock
}

function writeGolden(dir: string, name: string, content: unknown): void {
  const golden = join(dir, 'tooling', 'golden')
  mkdirSync(golden, { recursive: true })
  writeFileSync(
    join(golden, name),
    typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`,
  )
}

function baseDoc(): GoldenDoc {
  return {
    contract: 'demo contract',
    specification: 'docs/demo.md',
    vectors: [
      { id: 'demo-001', input: 'a', expected: 'A' },
      { id: 'demo-002', input: 'b', expected: 'B', nested: { list: [1, 2, 3] } },
    ],
  }
}

/** A repository whose base commit holds demo.json and its lock; returns the dir and base sha. */
function repoWithBase(files: Record<string, GoldenDoc> = { 'demo.json': baseDoc() }): {
  dir: string
  base: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'exdb-golden-history-'))
  repos.push(dir)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'test')
  git(dir, 'config', 'user.email', 'test@example.invalid')
  git(dir, 'config', 'commit.gpgsign', 'false')
  for (const [name, doc] of Object.entries(files)) {
    writeGolden(dir, name, doc)
  }
  writeGolden(dir, 'LOCK.json', lockFor(files))
  writeGolden(dir, 'README.md', 'data only\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'base')
  return { dir, base: git(dir, 'rev-parse', 'HEAD') }
}

function problemsOf(dir: string, base: string): readonly string[] {
  const result = checkGoldenHistory(dir, base)
  return result.ok ? [] : result.problems
}

describe('golden history guard', () => {
  it('passes when nothing changed', () => {
    const { dir, base } = repoWithBase()
    const result = checkGoldenHistory(dir, base)
    expect(result.ok).toBe(true)
    expect(result.ok && result.summary.baseVectors).toBe(2)
  })

  it('passes when only formatting or vector order changed (canonically identical)', () => {
    const { dir, base } = repoWithBase()
    const doc = baseDoc()
    const reordered = { ...doc, vectors: [...doc.vectors].reverse() }
    writeGolden(dir, 'demo.json', JSON.stringify(reordered))
    expect(problemsOf(dir, base)).toEqual([])
  })

  it('fails when an old vector was changed', () => {
    const { dir, base } = repoWithBase()
    const doc = baseDoc()
    doc.vectors[0] = { id: 'demo-001', input: 'a', expected: 'Z' }
    writeGolden(dir, 'demo.json', doc)
    expect(problemsOf(dir, base).join('\n')).toMatch(/demo-001 of the base was changed/)
  })

  it('fails when a vector, its expected value and its lock entry were changed together', () => {
    const { dir, base } = repoWithBase()
    const doc = baseDoc()
    doc.vectors[0] = { id: 'demo-001', input: 'a2', expected: 'A2' }
    writeGolden(dir, 'demo.json', doc)
    writeGolden(dir, 'LOCK.json', lockFor({ 'demo.json': doc }))
    const problems = problemsOf(dir, base).join('\n')
    expect(problems).toMatch(/vector demo-001 of the base was changed/)
    expect(problems).toMatch(/entry demo.json\/demo-001 of the base was changed/)
  })

  it('fails when an old vector was removed, with or without its lock entry', () => {
    const { dir, base } = repoWithBase()
    const doc = baseDoc()
    doc.vectors = doc.vectors.slice(1)
    writeGolden(dir, 'demo.json', doc)
    expect(problemsOf(dir, base).join('\n')).toMatch(/demo-001 of the base was removed/)
    writeGolden(dir, 'LOCK.json', lockFor({ 'demo.json': doc }))
    const problems = problemsOf(dir, base).join('\n')
    expect(problems).toMatch(/vector demo-001 of the base was removed/)
    expect(problems).toMatch(/entry demo.json\/demo-001 of the base was removed/)
  })

  it('fails when an old lock entry was changed', () => {
    const { dir, base } = repoWithBase()
    const lock = lockFor({ 'demo.json': baseDoc() })
    lock['demo.json'] = { ...lock['demo.json'], 'demo-002': 'f'.repeat(64) }
    writeGolden(dir, 'LOCK.json', lock)
    expect(problemsOf(dir, base).join('\n')).toMatch(
      /entry demo.json\/demo-002 of the base was changed/,
    )
  })

  it('fails when an old lock entry was deleted', () => {
    const { dir, base } = repoWithBase()
    const lock = lockFor({ 'demo.json': baseDoc() })
    const { 'demo-002': _removed, ...rest } = lock['demo.json'] ?? {}
    writeGolden(dir, 'LOCK.json', { 'demo.json': rest })
    expect(problemsOf(dir, base).join('\n')).toMatch(
      /entry demo.json\/demo-002 of the base was removed/,
    )
  })

  it('passes for a new vector with its lock entry', () => {
    const { dir, base } = repoWithBase()
    const doc = baseDoc()
    doc.vectors.push({ id: 'demo-003', input: 'c', expected: 'C' })
    writeGolden(dir, 'demo.json', doc)
    writeGolden(dir, 'LOCK.json', lockFor({ 'demo.json': doc }))
    const result = checkGoldenHistory(dir, base)
    expect(result.ok && result.summary.newVectors).toBe(1)
  })

  it('fails for a new vector without a lock entry or with a wrong one', () => {
    const { dir, base } = repoWithBase()
    const doc = baseDoc()
    doc.vectors.push({ id: 'demo-003', input: 'c', expected: 'C' })
    writeGolden(dir, 'demo.json', doc)
    expect(problemsOf(dir, base).join('\n')).toMatch(/new vector demo-003 has no LOCK.json entry/)
    const lock = lockFor({ 'demo.json': baseDoc() })
    lock['demo.json'] = { ...lock['demo.json'], 'demo-003': '0'.repeat(64) }
    writeGolden(dir, 'LOCK.json', lock)
    expect(problemsOf(dir, base).join('\n')).toMatch(/entry of new vector demo-003 does not match/)
  })

  it('passes for a new, correctly locked golden file and fails without its locks', () => {
    const { dir, base } = repoWithBase()
    const extra: GoldenDoc = {
      contract: 'second contract',
      specification: 'docs/second.md',
      vectors: [{ id: 'second-001', input: 'x', expected: 'y' }],
    }
    writeGolden(dir, 'second.json', extra)
    expect(problemsOf(dir, base).join('\n')).toMatch(/second-001 has no LOCK.json entry/)
    writeGolden(dir, 'LOCK.json', lockFor({ 'demo.json': baseDoc(), 'second.json': extra }))
    const result = checkGoldenHistory(dir, base)
    expect(result.ok && result.summary.newFiles).toBe(1)
  })

  it('fails when file metadata outside the vectors was changed, added or removed', () => {
    const { dir, base } = repoWithBase()
    writeGolden(dir, 'demo.json', { ...baseDoc(), specification: 'docs/other.md' })
    expect(problemsOf(dir, base).join('\n')).toMatch(/member "specification" was changed/)
    writeGolden(dir, 'demo.json', { ...baseDoc(), notes: 'reinterpreted' })
    expect(problemsOf(dir, base).join('\n')).toMatch(/member "notes" was added/)
    const { contract: _c, ...withoutContract } = baseDoc()
    writeGolden(dir, 'demo.json', withoutContract)
    expect(problemsOf(dir, base).join('\n')).toMatch(/member "contract" was removed/)
  })

  it('fails when a vector file or the lock of the base was removed', () => {
    const { dir, base } = repoWithBase()
    unlinkSync(join(dir, 'tooling', 'golden', 'demo.json'))
    expect(problemsOf(dir, base).join('\n')).toMatch(
      /demo.json: a vector file of the base was removed/,
    )
    const second = repoWithBase()
    unlinkSync(join(second.dir, 'tooling', 'golden', 'LOCK.json'))
    expect(problemsOf(second.dir, second.base).join('\n')).toMatch(/LOCK.json was removed/)
  })

  it('fails closed when the base ref is missing, unreadable or malformed', () => {
    const { dir } = repoWithBase()
    for (const ref of [
      '',
      'no-such-branch',
      '0000000000000000000000000000000000000000',
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      '--force',
      '-q',
      'main extra',
    ]) {
      expect(problemsOf(dir, ref).join('\n'), ref).toMatch(/fails closed/)
    }
  })

  it('fails closed when a golden file of the base cannot be parsed', () => {
    const { dir } = repoWithBase()
    writeGolden(dir, 'demo.json', '{"vectors": [')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'damaged')
    const damaged = git(dir, 'rev-parse', 'HEAD')
    writeGolden(dir, 'demo.json', baseDoc())
    expect(problemsOf(dir, damaged).join('\n')).toMatch(/fails closed/)
  })

  it('fails closed when the base has vectors but no lock', () => {
    const { dir } = repoWithBase()
    unlinkSync(join(dir, 'tooling', 'golden', 'LOCK.json'))
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'unlocked')
    const unlocked = git(dir, 'rev-parse', 'HEAD')
    writeGolden(dir, 'LOCK.json', lockFor({ 'demo.json': baseDoc() }))
    expect(problemsOf(dir, unlocked).join('\n')).toMatch(
      /no LOCK.json; the history check fails closed/,
    )
  })

  it('accepts only a base ref on the command line; no rebaseline or skip switch exists', () => {
    expect(parseArgs(['origin/main'])).toEqual({ ok: true, base: 'origin/main' })
    expect(parseArgs(['--base', 'abc123'])).toEqual({ ok: true, base: 'abc123' })
    expect(parseArgs(['--base=abc123'])).toEqual({ ok: true, base: 'abc123' })
    for (const argv of [
      [],
      ['--base'],
      ['--base='],
      ['a', 'b'],
      ['--force', 'main'],
      ['main', '--rewrite'],
      ['--accept-new-baseline', 'main'],
      ['--update-existing-locks', 'main'],
      ['--skip'],
    ]) {
      expect(parseArgs(argv).ok, argv.join(' ')).toBe(false)
    }
  })
})

describe('golden history guard: frozen Control Store bundles', () => {
  const ID = '01M46KHY80CWGMHV633DGSP8S8'
  const NEW_ID = '01M46VP9A1J9EGS4ZYVCFC16NQ'
  const bundleDir = (dir: string, id = ID, name = 'demo-bundle') =>
    join(dir, 'packages', 'control-store', 'migrations', `${id}_${name}`)

  function writeBundle(dir: string, id = ID, name = 'demo-bundle'): void {
    const root = bundleDir(dir, id, name)
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'migration.yaml'), `id: ${id}\nname: ${name}\n`)
    writeFileSync(join(root, 'up.sql'), '-- create\nCREATE TABLE t (id int);\n')
    writeFileSync(join(root, 'verify.sql'), '-- check: t exists\nSELECT true AS ok;\n')
  }

  function writeList(dir: string, entries: readonly Readonly<Record<string, string>>[]): void {
    const path = join(dir, 'packages', 'control-store')
    mkdirSync(path, { recursive: true })
    writeFileSync(
      join(path, 'frozen-bundles.json'),
      `${JSON.stringify(
        {
          contract: 'frozen bundles',
          bundles: entries.map((e) => ({ ...e, checksum: `sha256:c1:${'a'.repeat(64)}` })),
        },
        null,
        2,
      )}\n`,
    )
  }

  /** A base commit with golden vectors, one bundle and the list naming it. */
  function frozenBase(): { dir: string; base: string } {
    const { dir } = repoWithBase()
    writeBundle(dir)
    writeList(dir, [{ id: ID, name: 'demo-bundle' }])
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'freeze')
    return { dir, base: git(dir, 'rev-parse', 'HEAD') }
  }

  it('passes when a frozen bundle is byte-identical to the base', () => {
    const { dir, base } = frozenBase()
    const result = checkGoldenHistory(dir, base)
    expect(result.ok && result.summary.frozenBundles).toBe(1)
  })

  it('fails when a frozen bundle file is edited, even only in a comment', () => {
    const { dir, base } = frozenBase()
    writeFileSync(join(bundleDir(dir), 'up.sql'), '-- created\nCREATE TABLE t (id int);\n')
    expect(problemsOf(dir, base).join('\n')).toMatch(/frozen bundle was edited \(up.sql changed\)/)
  })

  it('fails when a file is added to or removed from a frozen bundle', () => {
    const { dir, base } = frozenBase()
    writeFileSync(join(bundleDir(dir), 'down.sql'), 'DROP TABLE t;\n')
    expect(problemsOf(dir, base).join('\n')).toMatch(/down.sql added/)
    unlinkSync(join(bundleDir(dir), 'down.sql'))
    unlinkSync(join(bundleDir(dir), 'verify.sql'))
    expect(problemsOf(dir, base).join('\n')).toMatch(/verify.sql removed/)
  })

  it('fails when the bundle, its pins and the list entry are edited together', () => {
    const { dir, base } = frozenBase()
    writeFileSync(join(bundleDir(dir), 'up.sql'), 'CREATE TABLE t (id bigint);\n')
    writeList(dir, [{ id: ID, name: 'demo-bundle', note: 'repinned' }])
    const problems = problemsOf(dir, base).join('\n')
    expect(problems).toMatch(/entry of frozen bundle .* was changed/)
    expect(problems).toMatch(/frozen bundle was edited/)
  })

  it('fails when a frozen entry or the whole list is removed', () => {
    const { dir, base } = frozenBase()
    writeList(dir, [])
    expect(problemsOf(dir, base).join('\n')).toMatch(/frozen bundle .* of the base was removed/)
    unlinkSync(join(dir, 'packages', 'control-store', 'frozen-bundles.json'))
    expect(problemsOf(dir, base).join('\n')).toMatch(/frozen-bundles.json was removed/)
  })

  it('accepts a newly frozen bundle that exists and refuses one that does not', () => {
    const { dir, base } = frozenBase()
    writeBundle(dir, NEW_ID, 'second-bundle')
    writeList(dir, [
      { id: ID, name: 'demo-bundle' },
      { id: NEW_ID, name: 'second-bundle' },
    ])
    const result = checkGoldenHistory(dir, base)
    expect(result.ok && result.summary.newFrozenBundles).toBe(1)
    writeList(dir, [
      { id: ID, name: 'demo-bundle' },
      { id: NEW_ID, name: 'missing-bundle' },
    ])
    expect(problemsOf(dir, base).join('\n')).toMatch(/names no bundle directory/)
  })

  it('leaves new, unlisted bundles free to change', () => {
    const { dir, base } = frozenBase()
    writeBundle(dir, NEW_ID, 'second-bundle')
    writeFileSync(join(bundleDir(dir, NEW_ID, 'second-bundle'), 'up.sql'), 'SELECT 1;\n')
    expect(problemsOf(dir, base)).toEqual([])
  })
})

describe('golden history guard: MCP tool version pins', () => {
  const PINS = 'packages/contracts/mcp-tool-versions.json'
  const digest = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`

  function writePins(dir: string, tools: Record<string, Record<string, string>>): void {
    mkdirSync(join(dir, 'packages', 'contracts'), { recursive: true })
    writeFileSync(
      join(dir, PINS),
      `${JSON.stringify({ schema: 'exponetdb.mcp-tool-versions/v1', tools }, null, 2)}\n`,
    )
  }

  function repoWithPins(): { dir: string; base: string } {
    const { dir } = repoWithBase()
    writePins(dir, { targets_list: { '1': digest(1) }, target_get: { '1': digest(2) } })
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'pins')
    return { dir, base: git(dir, 'rev-parse', 'HEAD') }
  }

  it('passes when the pins are unchanged and when a tool gains a higher version', () => {
    const { dir, base } = repoWithPins()
    expect(problemsOf(dir, base)).toEqual([])
    writePins(dir, {
      targets_list: { '1': digest(1), '2': digest(3) },
      target_get: { '1': digest(2) },
      sql_query: { '1': digest(4) },
    })
    const result = checkGoldenHistory(dir, base)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.summary).toMatchObject({ toolVersions: 2, newToolVersions: 2 })
    }
  })

  it('fails when a pinned version names another digest (a changed definition kept its version)', () => {
    const { dir, base } = repoWithPins()
    writePins(dir, { targets_list: { '1': digest(9) }, target_get: { '1': digest(2) } })
    expect(problemsOf(dir, base).join('\n')).toMatch(/targets_list version 1 names another digest/)
  })

  it('fails when a pinned version, a tool or the whole file is removed', () => {
    const { dir, base } = repoWithPins()
    writePins(dir, { targets_list: { '1': digest(1) } })
    expect(problemsOf(dir, base).join('\n')).toMatch(/target_get version 1 of the base was removed/)
    rmSync(join(dir, PINS))
    expect(problemsOf(dir, base).join('\n')).toMatch(
      /was removed \(tool version pins are append-only\)/,
    )
  })
})
