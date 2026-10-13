import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isSchemaKind,
  isSlug,
  isTargetPath,
  parseTargetParams,
  SLUG_PATTERN,
  splitTargetPath,
} from '../../src/features/target/params.ts'
import { SCHEMA_KINDS, safeReturnTo } from '../../src/lib/navigation/links.ts'

const HOSTILE = [
  '',
  'Staging',
  'STAGING',
  '1abc',
  '-abc',
  'a_b',
  'a.b',
  'a b',
  'a/b',
  'a\\b',
  '..',
  '.',
  'a%2Fb',
  '%2F',
  'a\u202Eb',
  '\u202Eab',
  'a\u200Bb',
  'a\u0000b',
  'ab\n',
  '\nab',
  'ab ',
  '\u00e4',
  '\u0430', // Cyrillic a
  'a'.repeat(40),
]

describe('the slug grammar of a target route', () => {
  it('is the registry grammar: a letter, then up to 38 letters, digits or hyphens', () => {
    expect(isSlug('a')).toBe(true)
    expect(isSlug('staging')).toBe(true)
    expect(isSlug('prod-eu-1')).toBe(true)
    expect(isSlug('a'.repeat(39))).toBe(true)
    expect(isSlug('a'.repeat(40))).toBe(false)
  })

  it.each(HOSTILE)('refuses %j', (value) => {
    expect(isSlug(value)).toBe(false)
    expect(parseTargetParams({ product: 'shop', project: 'platform', environment: value })).toBe(
      undefined,
    )
    expect(parseTargetParams({ product: value, project: 'platform', environment: 'staging' })).toBe(
      undefined,
    )
    expect(parseTargetParams({ product: 'shop', project: value, environment: 'staging' })).toBe(
      undefined,
    )
  })

  it('is the grammar of the contract, so the page and the server agree', () => {
    // The test runs from apps/web (vitest root), two levels below the repository root.
    const source = readFileSync(
      resolve(process.cwd(), '../../packages/contracts/src/common.ts'),
      'utf8',
    )
    expect(source).toContain(
      `export const SlugSchema = z.string().regex(${SLUG_PATTERN.toString()})`,
    )
  })

  it('agrees with the pages a sign-in may return to', () => {
    for (const value of ['staging', 'a'.repeat(39), 'a'.repeat(40), 'Staging', '1a', 'a_b']) {
      const path = `/t/shop/platform/${value}`
      expect(safeReturnTo(path) === path, value).toBe(isSlug(value))
    }
  })

  it('accepts only values that are strings', () => {
    expect(isSlug(undefined)).toBe(false)
    expect(isSlug(null)).toBe(false)
    expect(isSlug(7)).toBe(false)
    expect(parseTargetParams({})).toBe(undefined)
  })
})

describe('the target of the route parameters', () => {
  it('is the three slugs and their path', () => {
    expect(
      parseTargetParams({ product: 'shop', project: 'platform', environment: 'staging' }),
    ).toEqual({
      product: 'shop',
      project: 'platform',
      environment: 'staging',
      path: 'shop/platform/staging',
    })
  })

  it('splits a registry path into the same three parts, and nothing else', () => {
    expect(splitTargetPath('shop/platform/staging')?.environment).toBe('staging')
    for (const bad of [
      '',
      'shop/platform',
      'shop/platform/staging/x',
      'shop//staging',
      '/a/b/c',
      'A/b/c',
    ]) {
      expect(splitTargetPath(bad), bad).toBe(undefined)
      expect(isTargetPath(bad), bad).toBe(false)
    }
    expect(isTargetPath('shop/platform/staging\n')).toBe(false)
  })
})

describe('the schema kinds', () => {
  it('are the kinds of the navigation grammar and never an object name', () => {
    for (const kind of SCHEMA_KINDS) expect(isSchemaKind(kind)).toBe(true)
    for (const bad of [
      '',
      'public.users',
      'Tables',
      'tables/x',
      '..',
      'constructor',
      '__proto__',
      undefined,
    ]) {
      expect(isSchemaKind(bad)).toBe(false)
    }
  })
})
