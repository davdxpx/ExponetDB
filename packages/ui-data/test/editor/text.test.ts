import { describe, expect, it } from 'vitest'

import { toCompletions } from '../../src/editor/cm-completion.ts'
import {
  markInvisible,
  minimalChange,
  sameDiagnostics,
  singleLine,
  untrustedMessage,
} from '../../src/editor/text.ts'
import type { SqlDiagnostic } from '../../src/editor/types.ts'

describe('markInvisible (C-26)', () => {
  it('shows direction, zero-width and control characters by code point', () => {
    expect(markInvisible('a\u{202E}b')).toBe('a⟨U+202E⟩b')
    expect(markInvisible('x\u{200B}y\u{0000}z')).toBe('x⟨U+200B⟩y⟨U+0000⟩z')
    expect(markInvisible('\u{E0041}')).toBe('⟨U+E0041⟩')
  })

  it('leaves printable text, including non-ASCII letters, unchanged', () => {
    expect(markInvisible('select "naïve" from t')).toBe('select "naïve" from t')
  })
})

describe('singleLine and untrustedMessage', () => {
  it('turns line breaks and tabs into spaces and still marks the rest', () => {
    expect(singleLine('a\r\nb\tc\u{2066}')).toBe('a b c⟨U+2066⟩')
  })

  it('cuts a long message at a code point and says so', () => {
    const long = 'x'.repeat(600)
    const shown = untrustedMessage(long)
    expect(shown).toBe(`${'x'.repeat(500)}…`)
    expect(untrustedMessage('short')).toBe('short')
  })

  it('does not split an astral character when it cuts', () => {
    const shown = untrustedMessage('😀'.repeat(10), 3)
    expect(shown).toBe('😀😀😀…')
  })
})

describe('minimalChange', () => {
  it('is null for equal texts', () => {
    expect(minimalChange('same', 'same')).toBeNull()
  })

  it('keeps the common prefix and suffix', () => {
    expect(minimalChange('select 1 from t', 'select 2 from t')).toEqual({
      from: 7,
      to: 8,
      insert: '2',
    })
    expect(minimalChange('abc', 'abcdef')).toEqual({ from: 3, to: 3, insert: 'def' })
    expect(minimalChange('abcdef', 'abc')).toEqual({ from: 3, to: 6, insert: '' })
    expect(minimalChange('', 'x')).toEqual({ from: 0, to: 0, insert: 'x' })
  })

  it('never cuts a surrogate pair in half', () => {
    // 😀 and 😁 share the high surrogate; the change has to take the whole character.
    const change = minimalChange('a😀b', 'a😁b')
    expect(change).toEqual({ from: 1, to: 3, insert: '😁' })
    const applied = (text: string, c: { from: number; to: number; insert: string }) =>
      text.slice(0, c.from) + c.insert + text.slice(c.to)
    if (change !== null) expect(applied('a😀b', change)).toBe('a😁b')
  })
})

describe('sameDiagnostics', () => {
  const one: SqlDiagnostic = { line: 1, column: 2, severity: 'error', message: 'm' }

  it('compares findings by value', () => {
    expect(sameDiagnostics([one], [{ ...one }])).toBe(true)
    expect(sameDiagnostics([one], [{ ...one, message: 'n' }])).toBe(false)
    expect(sameDiagnostics([one], [])).toBe(false)
    expect(sameDiagnostics(undefined, undefined)).toBe(true)
    expect(sameDiagnostics(undefined, [one])).toBe(false)
  })
})

describe('toCompletions: what the provider returns is checked', () => {
  it('maps kinds to library types and keeps details short and on one line', () => {
    const out = toCompletions([
      { label: 'users', kind: 'table', detail: 'public\nschema' },
      { label: 'id', kind: 'column' },
      { label: 'now', kind: 'function' },
      { label: 'public', kind: 'schema' },
    ])
    expect(out.map((o) => [o.label, o.type])).toEqual([
      ['users', 'class'],
      ['id', 'property'],
      ['now', 'function'],
      ['public', 'namespace'],
    ])
    expect(out[0]?.detail).toBe('public schema')
  })

  it('shows invisible characters of a label and still inserts the label', () => {
    const [option] = toCompletions([{ label: 'ta\u{202E}ble', kind: 'table' }])
    expect(option?.label).toBe('ta\u{202E}ble')
    expect(option?.displayLabel).toBe('ta⟨U+202E⟩ble')
  })

  it('ignores anything malformed instead of failing', () => {
    expect(toCompletions(undefined)).toEqual([])
    expect(toCompletions('users')).toEqual([])
    expect(toCompletions({ label: 'x', kind: 'table' })).toEqual([])
    expect(
      toCompletions([
        null,
        7,
        { label: 5, kind: 'table' },
        { label: '', kind: 'table' },
        { label: 'a\nb', kind: 'table' },
        { label: 'ok', kind: 'toString' },
        { label: 'ok', kind: 'view' },
        { label: 'x'.repeat(257), kind: 'table' },
      ]),
    ).toEqual([])
  })

  it('drops a keyword the grammar already completes and caps the list', () => {
    expect(toCompletions([{ label: 'select', kind: 'keyword' }])).toEqual([])
    expect(toCompletions([{ label: 'my_special_word', kind: 'keyword' }])).toHaveLength(1)
    const many = Array.from({ length: 800 }, (_, i) => ({ label: `t${i}`, kind: 'table' }))
    expect(toCompletions(many)).toHaveLength(500)
  })
})
