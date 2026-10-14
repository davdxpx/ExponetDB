import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  bundledPackages,
  NOTICE_FILE,
  packageDirOf,
  renderNotices,
  verifyNoticeText,
} from '../../scripts/notices.ts'

const root = mkdtempSync(join(tmpdir(), 'exdb-notices-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function install(
  name: string,
  manifest: Record<string, unknown>,
  licenseFile?: { name: string; text: string },
): string {
  const dir = join(root, 'node_modules', name)
  mkdirSync(join(dir, 'dist'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }))
  writeFileSync(join(dir, 'dist', 'index.js'), '')
  if (licenseFile !== undefined) writeFileSync(join(dir, licenseFile.name), licenseFile.text)
  return join(dir, 'dist', 'index.js')
}

describe('the license notice of the bundle', () => {
  it('names the package behind a bundled module, scoped or not, ignoring query and prefix', () => {
    const base = join('x', 'node_modules')
    expect(packageDirOf(join(base, 'react', 'index.js'))).toBe(join(base, 'react'))
    expect(packageDirOf(join(base, '@radix-ui', 'react-dialog', 'dist', 'a.js?v=1'))).toBe(
      join(base, '@radix-ui', 'react-dialog'),
    )
    expect(packageDirOf(`\0${join(base, 'zod', 'a.js')}?commonjs-proxy`)).toBe(join(base, 'zod'))
    expect(packageDirOf(join('x', 'packages', 'ui', 'src', 'a.ts'))).toBeUndefined()
  })

  it('reads the license text and the declared license of each bundled package once', () => {
    const a = install(
      'alpha',
      { license: 'MIT', repository: { url: 'git+https://example.test/alpha.git' } },
      { name: 'LICENSE.md', text: 'Alpha license text\n' },
    )
    const b = install('beta', { license: 'ISC' })
    const found = bundledPackages([a, a, b])
    expect(found.problems).toEqual([])
    expect(found.packages.map((p) => `${p.name}@${p.version}`)).toEqual([
      'alpha@1.0.0',
      'beta@1.0.0',
    ])
    expect(found.packages[0]?.text).toBe('Alpha license text')
    expect(found.packages[1]?.text).toBeUndefined()
  })

  it('fails for a bundled package with neither a license file nor a declared license', () => {
    const c = install('gamma', {})
    const found = bundledPackages([c])
    expect(found.problems).toHaveLength(1)
    expect(found.problems[0]).toContain('gamma@1.0.0')
    expect(found.problems[0]).toContain('ships no license file and declares no license')
  })

  it('renders every package and the repository notices, and verification finds a missing section', () => {
    const a = install('delta', { license: 'MIT' }, { name: 'LICENSE', text: 'Delta text' })
    const { packages } = bundledPackages([a])
    const text = renderNotices(packages, [
      { title: 'Apache License 2.0 (Supabase)', text: 'Apache' },
    ])
    expect(text).toContain('Bundled npm packages: 1')
    expect(text).toContain('\ndelta 1.0.0\nLicense: MIT\n')
    expect(text).toContain('Delta text')
    expect(
      verifyNoticeText(text, [{ name: 'delta', version: '1.0.0' }], ['Apache License 2.0']),
    ).toEqual([])
    expect(
      verifyNoticeText(text, [{ name: 'epsilon', version: '1.0.0' }], ['Apache License 2.0']),
    ).toEqual([`${NOTICE_FILE}: no section for epsilon@1.0.0`])
    expect(verifyNoticeText(text, [], ['MIT License (shadcn/ui)'])).toEqual([
      `${NOTICE_FILE}: the notice "MIT License (shadcn/ui)" is missing`,
    ])
    expect(verifyNoticeText('nothing', [], [])[0]).toContain('not the generated notice file')
  })
})
