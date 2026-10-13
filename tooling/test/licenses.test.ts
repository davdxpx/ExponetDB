import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  allowedLicenses,
  checkLicenses,
  DEVELOPMENT_LICENSES,
  declaredLicense,
  evaluateSpdx,
  judge,
  LICENSE_OVERRIDES,
  parseSpdx,
  resolveInstalled,
  SHIPPED_LICENSES,
} from '../checks/licenses.ts'

describe('evaluateSpdx', () => {
  it('accepts either side of OR and needs both sides of AND', () => {
    expect(evaluateSpdx('MIT OR Apache-2.0', SHIPPED_LICENSES)).toBe(true)
    expect(evaluateSpdx('GPL-3.0-only OR MIT', SHIPPED_LICENSES)).toBe(true)
    expect(evaluateSpdx('GPL-3.0-only OR LGPL-3.0-only', SHIPPED_LICENSES)).toBe(false)
    expect(evaluateSpdx('MIT AND ISC', SHIPPED_LICENSES)).toBe(true)
    expect(evaluateSpdx('MIT AND GPL-3.0-only', SHIPPED_LICENSES)).toBe(false)
  })

  it('judges (MIT AND CC-BY-4.0) differently for shipped and development packages', () => {
    expect(evaluateSpdx('(MIT AND CC-BY-4.0)', SHIPPED_LICENSES)).toBe(false)
    expect(evaluateSpdx('(MIT AND CC-BY-4.0)', DEVELOPMENT_LICENSES)).toBe(true)
  })

  it('never accepts a copyleft license on its own', () => {
    for (const license of ['GPL-3.0-only', 'GPL-2.0-or-later', 'AGPL-3.0-only', 'LGPL-3.0-only']) {
      expect(evaluateSpdx(license, SHIPPED_LICENSES), license).toBe(false)
      expect(evaluateSpdx(license, DEVELOPMENT_LICENSES), license).toBe(false)
    }
  })

  it('treats a WITH exception as unknown, even when another side would pass', () => {
    expect(evaluateSpdx('Apache-2.0 WITH LLVM-exception', DEVELOPMENT_LICENSES)).toBe(false)
    expect(evaluateSpdx('(MIT OR Apache-2.0 WITH LLVM-exception)', DEVELOPMENT_LICENSES)).toBe(
      false,
    )
    const parsed = parseSpdx('Apache-2.0 WITH LLVM-exception')
    expect(parsed.ok).toBe(false)
  })

  it('binds AND tighter than OR and honors parentheses', () => {
    expect(evaluateSpdx('MIT OR GPL-3.0-only AND CC-BY-4.0', SHIPPED_LICENSES)).toBe(true)
    expect(evaluateSpdx('GPL-3.0-only AND MIT OR ISC', SHIPPED_LICENSES)).toBe(true)
    expect(evaluateSpdx('GPL-3.0-only AND (MIT OR ISC)', SHIPPED_LICENSES)).toBe(false)
    expect(evaluateSpdx('((MIT))', SHIPPED_LICENSES)).toBe(true)
    expect(evaluateSpdx('(MIT OR (ISC AND GPL-3.0-only))', SHIPPED_LICENSES)).toBe(true)
  })

  it('compares ids and operators case-insensitively', () => {
    expect(evaluateSpdx('mit', SHIPPED_LICENSES)).toBe(true)
    expect(evaluateSpdx('apache-2.0 or isc', SHIPPED_LICENSES)).toBe(true)
    expect(evaluateSpdx('MIT', ['mit'])).toBe(true)
  })

  it('refuses expressions that do not parse', () => {
    for (const expression of [
      '',
      '   ',
      'SEE LICENSE IN LICENSE',
      'Apache 2.0',
      'MIT OR',
      'OR MIT',
      '(MIT',
      'MIT)',
      'MIT AND OR ISC',
      'UNLICENSED!',
    ]) {
      expect(parseSpdx(expression).ok, expression).toBe(false)
      expect(evaluateSpdx(expression, SHIPPED_LICENSES), expression).toBe(false)
    }
  })
})

describe('judge', () => {
  const pkg = (name: string, license: string | undefined, version = '1.0.0') => ({
    name,
    version,
    license,
  })

  it('accepts the shipped allowlist', () => {
    for (const license of SHIPPED_LICENSES) {
      expect(judge(pkg('a', license), 'shipped').ok, license).toBe(true)
    }
  })

  it('accepts MPL-2.0, CC-BY-4.0 and Python-2.0 for development only', () => {
    for (const license of ['MPL-2.0', 'CC-BY-4.0', 'Python-2.0']) {
      expect(judge(pkg('tool', license), 'development').ok, license).toBe(true)
      const shipped = judge(pkg('tool', license), 'shipped')
      expect(shipped.ok, license).toBe(false)
      expect(shipped.reason).toContain('not allowed in the shipped closure')
    }
  })

  it('accepts OFL-1.1 only for @fontsource packages', () => {
    expect(judge(pkg('@fontsource/inter', 'OFL-1.1'), 'shipped').ok).toBe(true)
    expect(judge(pkg('@fontsource-variable/inter', 'OFL-1.1'), 'shipped').ok).toBe(false)
    expect(judge(pkg('some-font', 'OFL-1.1'), 'shipped').ok).toBe(false)
    expect(judge(pkg('some-font', 'OFL-1.1'), 'development').ok).toBe(false)
    expect(allowedLicenses('@fontsource/inter', 'shipped')).toContain('OFL-1.1')
    expect(allowedLicenses('left-pad', 'shipped')).not.toContain('OFL-1.1')
  })

  it('refuses a missing or unparsable license and names the remedy', () => {
    const none = judge(pkg('nolicense', undefined), 'shipped')
    expect(none).toMatchObject({ ok: false, license: '(none)' })
    expect(none.reason).toContain('no license is declared')
    expect(none.reason).toContain('LICENSE_OVERRIDES')
    const blank = judge(pkg('blank', '  '), 'development')
    expect(blank.ok).toBe(false)
    const see = judge(pkg('see', 'SEE LICENSE IN LICENSE.md'), 'development')
    expect(see).toMatchObject({ ok: false, license: 'SEE LICENSE IN LICENSE.md' })
  })

  it('refuses a disallowed license and lists what is allowed', () => {
    const verdict = judge(pkg('copyleft', 'GPL-3.0-only'), 'shipped')
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('not allowed in the shipped closure (allowed: MIT, MIT-0')
  })

  it('starts with no override and applies a verified one only to a missing or unparsable license', () => {
    expect(Object.keys(LICENSE_OVERRIDES)).toEqual([])
    const overrides = {
      'odd@2.0.0': { license: 'MIT', reason: 'verified from its LICENSE file' },
      'gpl@1.0.0': { license: 'MIT', reason: 'must not hide a real GPL declaration' },
    }
    const fixed = judge(pkg('odd', undefined, '2.0.0'), 'shipped', overrides)
    expect(fixed).toMatchObject({ ok: true, license: 'MIT' })
    expect(fixed.reason).toContain('override: verified from its LICENSE file')
    expect(judge(pkg('odd', 'SEE LICENSE IN x', '2.0.0'), 'shipped', overrides).ok).toBe(true)
    expect(judge(pkg('odd', undefined, '3.0.0'), 'shipped', overrides).ok).toBe(false)
    expect(judge(pkg('gpl', 'GPL-3.0-only'), 'shipped', overrides).ok).toBe(false)
  })
})

describe('declaredLicense', () => {
  it('reads the SPDX string, the legacy object and the legacy array', () => {
    expect(declaredLicense({ license: 'ISC' })).toBe('ISC')
    expect(declaredLicense({ license: { type: 'MIT', url: 'https://example.invalid' } })).toBe(
      'MIT',
    )
    expect(declaredLicense({ licenses: [{ type: 'MIT' }] })).toBe('MIT')
    expect(declaredLicense({ licenses: [{ type: 'MIT' }, 'Apache-2.0'] })).toBe('MIT OR Apache-2.0')
    expect(declaredLicense({ license: 'ISC', licenses: [{ type: 'MIT' }] })).toBe('ISC')
    expect(declaredLicense({ name: 'x' })).toBeUndefined()
    expect(declaredLicense({ license: 42 })).toBeUndefined()
    expect(declaredLicense({ licenses: [] })).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// The walker over a Bun-style isolated install, built in a temporary directory.
// ---------------------------------------------------------------------------

const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

type Json = Record<string, unknown>
type Links = Record<string, string>

function tree() {
  const base = mkdtempSync(join(tmpdir(), 'exdb-licenses-'))
  created.push(base)
  const modulesOf = (name: string, version: string): string =>
    join(base, 'node_modules', '.bun', `${name.replace('/', '+')}@${version}`, 'node_modules')
  const writeManifest = (dir: string, json: Json): void => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify(json))
  }
  const link = (modules: string, name: string, version: string): void => {
    mkdirSync(dirname(join(modules, name)), { recursive: true })
    symlinkSync(join(modulesOf(name, version), name), join(modules, name))
  }
  return {
    base,
    /** The root package; `links` are its installed dependencies (name -> version). */
    root(json: Json, links: Links = {}): void {
      writeManifest(base, {
        name: 'root',
        private: true,
        workspaces: ['apps/*', 'packages/*', 'tooling'],
        ...json,
      })
      for (const [dep, version] of Object.entries(links)) {
        link(join(base, 'node_modules'), dep, version)
      }
    },
    /** A workspace package with its own `node_modules` links. */
    workspace(rel: string, json: Json, links: Links = {}): void {
      writeManifest(join(base, rel), json)
      for (const [dep, version] of Object.entries(links)) {
        link(join(base, rel, 'node_modules'), dep, version)
      }
    },
    /** A package in Bun's store; `links` are the siblings it can resolve. */
    pkg(name: string, version: string, json: Json = {}, links: Links = {}): void {
      const modules = modulesOf(name, version)
      writeManifest(join(modules, name), { name, version, ...json })
      for (const [dep, depVersion] of Object.entries(links)) {
        link(modules, dep, depVersion)
      }
    },
  }
}

describe('checkLicenses on an isolated install', () => {
  it('walks dependencies, installed peers and skips what is not installed', () => {
    const t = tree()
    t.root({ devDependencies: { tool: '1.0.0' } }, { tool: '1.0.0' })
    t.workspace(
      'packages/lib',
      {
        name: '@x/lib',
        dependencies: { a: '1.0.0' },
        optionalDependencies: { 'native-other-platform': '1.0.0' },
        peerDependencies: { 'peer-not-installed': '1.0.0' },
      },
      { a: '1.0.0' },
    )
    t.pkg(
      'a',
      '1.0.0',
      {
        license: 'MIT',
        dependencies: { b: '1.0.0' },
        peerDependencies: { p: '1.0.0', 'peer-gone': '1.0.0' },
        optionalDependencies: { 'optional-gone': '1.0.0' },
      },
      { b: '1.0.0', p: '1.0.0' },
    )
    t.pkg('b', '1.0.0', { license: 'Apache-2.0' })
    t.pkg('p', '1.0.0', { license: 'ISC' })
    t.pkg(
      'tool',
      '1.0.0',
      { license: 'MPL-2.0', dependencies: { data: '1.0.0' } },
      { data: '1.0.0' },
    )
    t.pkg('data', '1.0.0', { license: 'CC-BY-4.0' })
    expect(checkLicenses(t.base)).toEqual({ problems: [], shipped: 3, development: 2 })
  })

  it('fails on a copyleft license in the shipped closure, also when it is transitive', () => {
    const t = tree()
    t.root({})
    t.workspace('apps/web', { name: '@x/web', dependencies: { a: '1.0.0' } }, { a: '1.0.0' })
    t.pkg('a', '1.0.0', { license: 'MIT', dependencies: { deep: '2.3.4' } }, { deep: '2.3.4' })
    t.pkg('deep', '2.3.4', { license: 'LGPL-3.0-only' })
    const report = checkLicenses(t.base)
    expect(report.problems).toHaveLength(1)
    expect(report.problems[0]).toBe(
      'deep@2.3.4 (shipped): LGPL-3.0-only — not allowed in the shipped closure (allowed: MIT, MIT-0, ISC, Apache-2.0, BSD-2-Clause, BSD-3-Clause, 0BSD, CC0-1.0, BlueOak-1.0.0, Unlicense)',
    )
  })

  it('judges a package in both closures as shipped', () => {
    const t = tree()
    t.root(
      { devDependencies: { both: '1.0.0', 'dev-only': '1.0.0' } },
      { both: '1.0.0', 'dev-only': '1.0.0' },
    )
    t.workspace(
      'packages/lib',
      { name: '@x/lib', dependencies: { both: '1.0.0' } },
      { both: '1.0.0' },
    )
    t.pkg('both', '1.0.0', { license: 'MPL-2.0' })
    t.pkg('dev-only', '1.0.0', { license: 'MPL-2.0' })
    const report = checkLicenses(t.base)
    expect(report.shipped).toBe(1)
    expect(report.development).toBe(1)
    expect(report.problems).toHaveLength(1)
    expect(report.problems[0]).toContain('both@1.0.0 (shipped): MPL-2.0 — not allowed')
  })

  it('does not ship the development dependencies of a workspace package or of a dependency', () => {
    const t = tree()
    t.root({})
    t.workspace(
      'packages/lib',
      { name: '@x/lib', dependencies: { a: '1.0.0' }, devDependencies: { 'test-tool': '1.0.0' } },
      { a: '1.0.0', 'test-tool': '1.0.0' },
    )
    t.pkg('a', '1.0.0', { license: 'MIT', devDependencies: { 'a-dev': '1.0.0' } })
    t.pkg('test-tool', '1.0.0', { license: 'MPL-2.0' })
    expect(checkLicenses(t.base)).toEqual({ problems: [], shipped: 1, development: 1 })
  })

  it('walks into a workspace dependency and its dependencies', () => {
    const t = tree()
    t.root({})
    t.workspace(
      'apps/server',
      { name: '@x/server', dependencies: { '@x/core': 'workspace:*' } },
      {},
    )
    t.workspace('packages/core', { name: '@x/core', dependencies: { z: '1.0.0' } }, { z: '1.0.0' })
    t.pkg('z', '1.0.0', { license: 'GPL-3.0-only' })
    const report = checkLicenses(t.base)
    expect(report.shipped).toBe(1)
    expect(report.problems).toEqual([expect.stringContaining('z@1.0.0 (shipped): GPL-3.0-only')])
  })

  it('treats tooling and root dependencies as development', () => {
    const t = tree()
    t.root({ dependencies: { r: '1.0.0' } }, { r: '1.0.0' })
    t.workspace('tooling', { name: '@x/tooling', dependencies: { u: '1.0.0' } }, { u: '1.0.0' })
    t.pkg('r', '1.0.0', { license: 'MPL-2.0' })
    t.pkg('u', '1.0.0', { license: 'Python-2.0' })
    expect(checkLicenses(t.base)).toEqual({ problems: [], shipped: 0, development: 2 })
  })

  it('reports a missing and an unparsable license, accepts the legacy forms', () => {
    const t = tree()
    t.root({})
    t.workspace(
      'packages/lib',
      {
        name: '@x/lib',
        dependencies: { none: '1.0.0', odd: '1.0.0', legacy: '1.0.0', obj: '1.0.0' },
      },
      { none: '1.0.0', odd: '1.0.0', legacy: '1.0.0', obj: '1.0.0' },
    )
    t.pkg('none', '1.0.0', {})
    t.pkg('odd', '1.0.0', { license: 'SEE LICENSE IN LICENSE' })
    t.pkg('legacy', '1.0.0', { licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })
    t.pkg('obj', '1.0.0', { license: { type: 'ISC' } })
    const report = checkLicenses(t.base)
    expect(report.shipped).toBe(4)
    expect(report.problems).toHaveLength(2)
    expect(report.problems[0]).toContain('none@1.0.0 (shipped): (none) — no license is declared')
    expect(report.problems[1]).toContain('odd@1.0.0 (shipped): SEE LICENSE IN LICENSE')
  })

  it('accepts @fontsource OFL-1.1 when shipped and refuses it elsewhere', () => {
    const t = tree()
    t.root({})
    t.workspace(
      'apps/design-system',
      { name: '@x/ds', dependencies: { '@fontsource/inter': '5.0.0', 'other-font': '1.0.0' } },
      { '@fontsource/inter': '5.0.0', 'other-font': '1.0.0' },
    )
    t.pkg('@fontsource/inter', '5.0.0', { license: 'OFL-1.1' })
    t.pkg('other-font', '1.0.0', { license: 'OFL-1.1' })
    const report = checkLicenses(t.base)
    expect(report.shipped).toBe(2)
    expect(report.problems).toEqual([
      expect.stringContaining('other-font@1.0.0 (shipped): OFL-1.1'),
    ])
  })

  it('reports a declared dependency that is not installed instead of passing silently', () => {
    const t = tree()
    t.root({})
    t.workspace('packages/lib', { name: '@x/lib', dependencies: { ghost: '1.0.0' } })
    expect(checkLicenses(t.base)).toEqual({
      problems: [
        'packages/lib/package.json: dependencies "ghost" is not installed (run bun install)',
      ],
      shipped: 0,
      development: 0,
    })
  })

  it('counts a package once however many store variants it has', () => {
    const t = tree()
    t.root({})
    t.workspace(
      'packages/lib',
      { name: '@x/lib', dependencies: { a: '1.0.0', c: '1.0.0' } },
      { a: '1.0.0', c: '1.0.0' },
    )
    t.pkg('a', '1.0.0', { license: 'MIT', dependencies: { shared: '1.0.0' } }, { shared: '1.0.0' })
    t.pkg('c', '1.0.0', { license: 'MIT', dependencies: { shared: '1.0.0' } }, { shared: '1.0.0' })
    t.pkg('shared', '1.0.0', { license: 'ISC' })
    expect(checkLicenses(t.base)).toEqual({ problems: [], shipped: 3, development: 0 })
  })
})

describe('resolveInstalled', () => {
  it('finds a store package by its sibling link and a workspace package by its own links', () => {
    const t = tree()
    t.root({})
    t.workspace('packages/lib', { name: '@x/lib' }, { '@scope/dep': '1.0.0' })
    t.pkg(
      '@scope/dep',
      '1.0.0',
      { license: 'MIT', dependencies: { inner: '1.0.0' } },
      { inner: '1.0.0' },
    )
    t.pkg('inner', '1.0.0', { license: 'MIT' })
    const dep = resolveInstalled(join(t.base, 'packages', 'lib'), '@scope/dep')
    expect(dep).toBeDefined()
    expect(dep).toContain('@scope+dep@1.0.0')
    expect(resolveInstalled(dep ?? '', 'inner')).toContain('inner@1.0.0')
    expect(resolveInstalled(dep ?? '', 'missing')).toBeUndefined()
  })
})
