import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { COVERAGE, STATE_MARKERS, STATES, type State } from './registry.ts'

const app = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const toPosix = (path: string): string => path.split('\\').join('/')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

/** What makes a component a data component: it renders or takes a `Readable<T>`. */
const DATA_COMPONENT = /\b(ReadableView|toReadable)\b|\bReadable<|<ReadSection\b/

function dataComponents(root: string): string[] {
  return walk(join(root, 'src', 'features'))
    .filter((path) => path.endsWith('.tsx'))
    .filter((path) => DATA_COMPONENT.test(readFileSync(path, 'utf8')))
    .map((path) => toPosix(relative(root, path)))
    .sort()
}

/** The names of the `it(...)` and `test(...)` calls in a test source (also `.each`). */
function testNames(source: string): string[] {
  const names: string[] = []
  for (const match of source.matchAll(
    /\b(?:it|test)(?:\.each\([^)]*\))?\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g,
  )) {
    names.push(match[2] ?? '')
  }
  return names
}

function missingStates(
  names: readonly string[],
  exempt: Partial<Record<State, string>> = {},
): State[] {
  return STATES.filter(
    (state) => exempt[state] === undefined && !names.some((n) => STATE_MARKERS[state].test(n)),
  )
}

function namesOf(tests: readonly string[]): string[] {
  return tests.flatMap((t) => {
    const path = join(app, 'test', t)
    return existsSync(path) ? testNames(readFileSync(path, 'utf8')) : []
  })
}

describe('the truthful-state registry (C-28)', () => {
  it('has an entry for every data component under src/features, so a new screen without one fails', () => {
    const found = dataComponents(app)
    expect(found.length).toBeGreaterThan(40)
    expect(found.filter((path) => COVERAGE[path] === undefined)).toEqual([])
  })

  it('names no component that no longer renders a Readable', () => {
    const found = new Set(dataComponents(app))
    expect(Object.keys(COVERAGE).filter((path) => !found.has(path))).toEqual([])
  })

  it('names only test files that exist', () => {
    const missing = Object.entries(COVERAGE).flatMap(([source, entry]) =>
      entry.tests.filter((t) => !existsSync(join(app, 'test', t))).map((t) => `${source}: ${t}`),
    )
    expect(missing).toEqual([])
  })

  it('has a reason for every exemption and none for a state that a test covers', () => {
    const problems: string[] = []
    for (const [source, entry] of Object.entries(COVERAGE)) {
      const names = namesOf(entry.tests)
      for (const [state, reason] of Object.entries(entry.exempt ?? {}) as [State, string][]) {
        if (reason.trim().length < 20)
          problems.push(`${source}: exemption of ${state} has no reason`)
        if (names.some((n) => STATE_MARKERS[state].test(n))) {
          problems.push(`${source}: ${state} is covered, so its exemption is stale`)
        }
      }
    }
    expect(problems).toEqual([])
  })

  it('has a test named for the failed, stale, partial and empty state of every component', () => {
    const gaps: string[] = []
    for (const [source, entry] of Object.entries(COVERAGE)) {
      const missing = missingStates(namesOf(entry.tests), entry.exempt)
      if (missing.length > 0) gaps.push(`${source}: no test named for ${missing.join(', ')}`)
    }
    expect(gaps).toEqual([])
  })
})

describe('the state markers', () => {
  it('finds a test by the word of its state', () => {
    const names = testNames(`
      it('shows a failed read as failed, never as an empty list', () => {})
      it("shows an old read as stale", () => {})
      test('says a longer list is partial', () => {})
    `)
    expect(names).toHaveLength(3)
    expect(missingStates(names)).toEqual([])
  })

  it('reports a state no test is named for, unless it is exempted with a reason', () => {
    const names = testNames("it('shows a failed read as failed', () => {})")
    expect(missingStates(names)).toEqual(['stale', 'partial', 'empty'])
    expect(missingStates(names, { stale: 'the API has no age' })).toEqual(['partial', 'empty'])
  })
})
