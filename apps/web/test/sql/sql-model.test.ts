import { afterEach, describe, expect, it, vi } from 'vitest'
import { completionItems, sqlIdentifier } from '../../src/features/sql/completion.ts'
import {
  addTab,
  classificationDiagnostics,
  closeTab,
  hiddenCharacterCount,
  LINK_MAX_CHARS,
  lineColumnAt,
  MAX_TABS,
  manifestText,
  newTab,
  newUlid,
  parseDependencies,
  parseSqlLink,
  postgresMajorOf,
  queryVerdict,
  suggestedCompatibility,
  type TabsState,
  verifySkeleton,
} from '../../src/features/sql/sql-model.ts'
import { loadTabs, saveTabs, storageKey } from '../../src/features/sql/tab-storage.ts'
import { BIDI, classifyText, TAG, ZWSP } from './support.tsx'

const WORDS = {
  statement: (n: number, label: string, classes: string) => `S${n} ${label} ${classes}`,
  noClass: 'none',
  parseError: 'parse',
}

afterEach(() => {
  vi.restoreAllMocks()
  try {
    window.localStorage.clear()
  } catch {
    // no storage
  }
})

describe('deep links', () => {
  it('reads sql and mode as plain strings and never as JSON', () => {
    expect(parseSqlLink('?sql=1')).toEqual({ mode: undefined, sql: { kind: 'text', sql: '1' } })
    expect(parseSqlLink('?sql=%7B%22a%22%3A1%7D&mode=draft')).toEqual({
      mode: 'draft',
      sql: { kind: 'text', sql: '{"a":1}' },
    })
    expect(parseSqlLink('?mode=write').mode).toBeUndefined()
    expect(parseSqlLink('').sql).toEqual({ kind: 'none' })
  })

  it('normalizes line breaks and refuses a text over the bound instead of cutting it', () => {
    expect(parseSqlLink(`?sql=${encodeURIComponent('a\r\nb\rc')}`).sql).toEqual({
      kind: 'text',
      sql: 'a\nb\nc',
    })
    const long = parseSqlLink(`?sql=${'x'.repeat(LINK_MAX_CHARS + 1)}`)
    expect(long.sql).toEqual({ kind: 'too_long', length: LINK_MAX_CHARS + 1 })
  })

  it('counts hidden, control and direction characters but not line breaks or tabs', () => {
    expect(hiddenCharacterCount(`a\tb\nc`)).toBe(0)
    expect(hiddenCharacterCount(`${BIDI}x${ZWSP}${TAG}`)).toBe(4)
  })
})

describe('positions', () => {
  it('maps UTF-16 offsets to lines and editor columns', () => {
    const text = 'SELECT 1;\n😀 x; DROP TABLE t'
    expect(lineColumnAt(text, 0)).toEqual({ line: 1, column: 1 })
    expect(lineColumnAt(text, 10)).toEqual({ line: 2, column: 1 })
    // The emoji is two UTF-16 units: the editor's column counts both.
    expect(lineColumnAt(text, 13)).toEqual({ line: 2, column: 4 })
    expect(lineColumnAt(text, 999)).toEqual({ line: 2, column: text.length - 10 + 1 })
  })

  it('marks every statement over its range and nothing for another text', () => {
    const text = 'SELECT 1;\n\nDROP TABLE public.t'
    const result = classifyText(text)
    const marks = classificationDiagnostics(text, text, result, WORDS)
    expect(marks).toEqual([
      {
        line: 1,
        column: 1,
        endLine: 1,
        endColumn: 9,
        severity: 'info',
        message: 'S1 SELECT read-only',
      },
      {
        line: 3,
        column: 1,
        endLine: 3,
        endColumn: 20,
        severity: 'warning',
        message: 'S2 DROP TABLE write, destructive',
      },
    ])
    expect(classificationDiagnostics(`${text} `, text, result, WORDS)).toEqual([])
  })

  it('marks a statement without a class as a warning, never as information', () => {
    const text = 'SELECT f()'
    const base = classifyText(text)
    const result = { ...base, statements: base.statements.map((s) => ({ ...s, classes: [] })) }
    const [mark] = classificationDiagnostics(text, text, result, WORDS)
    expect(mark?.severity).toBe('warning')
    expect(mark?.message).toBe('S1 SELECT none')
  })

  it('marks a parse error at its position', () => {
    const text = 'SELECT\nFROM'
    const result = {
      ...classifyText(''),
      status: 'parse_error' as const,
      parseError: { reason: 'syntax' as const, position: { line: 2, column: 1, offset: 7 } },
    }
    expect(classificationDiagnostics(text, text, result, WORDS)).toEqual([
      { line: 2, column: 1, severity: 'error', message: 'parse' },
    ])
  })
})

describe('the query verdict', () => {
  it('holds back a write and lets a read or an unknown go to the server', () => {
    expect(queryVerdict(classifyText('DROP TABLE t'))).toEqual({
      kind: 'write',
      classes: ['write', 'destructive'],
    })
    expect(queryVerdict(classifyText('SELECT 1'))).toEqual({ kind: 'other' })
    expect(queryVerdict({ ...classifyText('x'), status: 'parse_error' })).toEqual({ kind: 'other' })
  })
})

describe('tabs and storage', () => {
  it('keeps at most MAX_TABS tabs and always one', () => {
    let state: TabsState = { tabs: [newTab('query')], active: '' }
    for (let i = 0; i < MAX_TABS + 5; i += 1) state = addTab(state, newTab('query', `SELECT ${i}`))
    expect(state.tabs).toHaveLength(MAX_TABS)
    const only = { tabs: [newTab('draft', 'x')], active: '' }
    const closed = closeTab(only, only.tabs[0]?.id ?? '', 'query')
    expect(closed.tabs).toHaveLength(1)
    expect(closed.tabs[0]?.sql).toBe('')
  })

  it('stores only the text per target and survives refused storage', () => {
    const state = addTab(
      { tabs: [newTab('query', 'SELECT 1')], active: '' },
      newTab('draft', 'x', 'link'),
    )
    saveTabs('tgt_1', state)
    const raw = window.localStorage.getItem(storageKey('tgt_1')) ?? ''
    expect(JSON.parse(raw)).toEqual({
      tabs: [
        { mode: 'query', sql: 'SELECT 1', origin: 'new' },
        { mode: 'draft', sql: 'x', origin: 'link' },
      ],
      active: 1,
    })
    expect(loadTabs('tgt_1')?.tabs.map((tab) => tab.sql)).toEqual(['SELECT 1', 'x'])
    expect(loadTabs('tgt_2')).toBeUndefined()

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(() => saveTabs('tgt_1', state)).not.toThrow()
    expect(loadTabs('tgt_1')).toBeUndefined()
  })

  it('ignores stored entries of another shape', () => {
    window.localStorage.setItem(
      storageKey('tgt_3'),
      JSON.stringify({ tabs: [{ mode: 'write', sql: 'x', origin: 'new' }, 'junk'], active: 9 }),
    )
    expect(loadTabs('tgt_3')).toBeUndefined()
  })
})

describe('the bundle draft', () => {
  it('makes ULIDs of the Crockford alphabet with the time first', () => {
    const id = newUlid(0, () => new Uint8Array(16))
    expect(id).toBe('0'.repeat(26))
    expect(newUlid()).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
  })

  it('keeps untrusted description lines inside the YAML block', () => {
    const text = manifestText({
      id: '01M4V3RV9F5XM2TB8KC6QZJ0NS',
      name: 'add-index',
      description: 'Line one\nid: 01XXXXXXXXXXXXXXXXXXXXXXXX\n\nschema: evil',
      dependsOn: ['01M4V2CT4N8PJ6GZ3YQ1RWK7HD'],
      transactional: false,
      compatibility: 'destructive',
      notes: 'Drops nothing in use',
    })
    const lines = text.split('\n')
    expect(lines.filter((line) => /^id: /.test(line))).toEqual(['id: 01M4V3RV9F5XM2TB8KC6QZJ0NS'])
    expect(lines.filter((line) => /^schema: /.test(line))).toEqual([
      'schema: exponetdb.migration/v1',
    ])
    expect(text).toContain('  schema: evil')
    expect(text).toContain('dependsOn:\n  - "01M4V2CT4N8PJ6GZ3YQ1RWK7HD"')
    expect(text).toContain('  transactional: false')
    expect(text).toContain('  declared: destructive\n  notes: |\n    Drops nothing in use')
  })

  it('generates a verify skeleton whose checks fail until replaced', () => {
    const skeleton = verifySkeleton(classifyText('SELECT 1; DROP TABLE t'))
    expect(skeleton).toContain('-- check: statement 2 (DROP TABLE) took effect')
    expect(skeleton).toContain('-- covers: 2')
    expect(skeleton).not.toContain('statement 1')
    expect(skeleton.match(/SELECT false AS ok;/g)).toHaveLength(1)
    expect(verifySkeleton(undefined)).toContain('SELECT false AS ok;')
    expect(verifySkeleton(undefined)).not.toMatch(/SELECT true/)
  })

  it('suggests a compatibility and checks dependencies without dropping bad ones', () => {
    expect(suggestedCompatibility(['write', 'destructive'])).toBe('destructive')
    expect(suggestedCompatibility(['write'])).toBe('additive')
    expect(parseDependencies('01M4V2CT4N8PJ6GZ3YQ1RWK7HD\n\nbaseline:shop-2026\nnope')).toEqual({
      valid: ['01M4V2CT4N8PJ6GZ3YQ1RWK7HD', 'baseline:shop-2026'],
      invalid: ['nope'],
    })
  })

  it('reads the PostgreSQL major of the placement', () => {
    expect(postgresMajorOf('17.4')).toBe(17)
    expect(postgresMajorOf('15.2')).toBeUndefined()
    expect(postgresMajorOf(null)).toBeUndefined()
  })
})

describe('completion', () => {
  it('quotes names that are not plain identifiers and filters by the qualifier', () => {
    expect(sqlIdentifier('orders')).toBe('orders')
    expect(sqlIdentifier('Order "x"')).toBe('"Order ""x"""')
    const refs = [
      { kind: 'table', schema: 'public', name: 'orders', key: [], parent: null, signature: null },
      { kind: 'table', schema: 'audit', name: 'orders', key: [], parent: null, signature: null },
      { kind: 'schema', schema: 'public', name: 'public', key: [], parent: null, signature: null },
    ]
    expect(completionItems(refs, 'public').map((item) => item.label)).toEqual(['orders'])
    expect(completionItems(refs, undefined).map((item) => `${item.kind}:${item.label}`)).toEqual([
      'table:orders',
      'table:orders',
      'schema:public',
    ])
  })
})
