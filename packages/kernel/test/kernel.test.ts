import { describe, expect, it } from 'vitest'
import { sha256, sha256Hex, sha256HexOf } from '../src/hash/index.ts'
import {
  andThen,
  assertNever,
  compareUtf8,
  decodeUtf8,
  err,
  expectOk,
  failure,
  fixedClock,
  formatTimestamp,
  InvariantError,
  invariant,
  manualClock,
  mapResult,
  ok,
  systemClock,
} from '../src/index.ts'

describe('Result', () => {
  it('maps and chains', () => {
    expect(mapResult(ok(2), (x) => x * 2)).toEqual(ok(4))
    expect(mapResult(err('e'), (x: number) => x * 2)).toEqual(err('e'))
    expect(andThen(ok(2), (x) => (x > 1 ? ok(x) : err('small')))).toEqual(ok(2))
    expect(andThen(ok(0), (x) => (x > 1 ? ok(x) : err('small')))).toEqual(err('small'))
  })
})

describe('error classes', () => {
  it('separates bugs (thrown) from expected failures (returned)', () => {
    expect(() => invariant(false, 'broken')).toThrow(InvariantError)
    expect(() => invariant(true, 'fine')).not.toThrow()
    expect(() => expectOk(err('x'), 'context')).toThrow('expected success: context')
    expect(expectOk(ok(1), 'context')).toBe(1)
    // A value outside the union reaches assertNever only past the type system
    // (for example from unvalidated JSON); the compiler must refuse the call,
    // and at run time it must throw.
    // @ts-expect-error 'x' is not assignable to never
    expect(() => assertNever('x', 'switch')).toThrow(InvariantError)
  })

  it('builds failures with and without details', () => {
    expect(failure('A', 'message')).toEqual({ code: 'A', message: 'message' })
    expect(failure('A', 'message', { n: 1 })).toEqual({
      code: 'A',
      message: 'message',
      details: { n: 1 },
    })
  })
})

describe('SHA-256', () => {
  it('matches the FIPS 180-2 test vector for "abc"', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('hashes empty input', () => {
    expect(sha256Hex(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('hashes strings as UTF-8 and chunks like the concatenation', () => {
    expect(sha256Hex('é')).toBe(sha256Hex(new Uint8Array([0xc3, 0xa9])))
    expect(sha256HexOf([new Uint8Array([0x61]), new Uint8Array([0x62, 0x63])])).toBe(
      sha256Hex('abc'),
    )
    expect(sha256('abc')).toHaveLength(32)
  })
})

describe('UTF-8', () => {
  it('keeps a leading BOM so callers can refuse it', () => {
    expect(decodeUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toEqual(ok('﻿A'))
  })

  it('refuses overlong forms, surrogates and truncated sequences', () => {
    for (const bytes of [
      [0xc0, 0xaf],
      [0xed, 0xa0, 0x80],
      [0xf4, 0x90, 0x80, 0x80],
      [0xc3],
      [0x80],
    ]) {
      expect(decodeUtf8(new Uint8Array(bytes))).toEqual(err('invalid_utf8'))
    }
  })

  it('compares by UTF-8 bytes (code point order), not UTF-16 units', () => {
    expect(compareUtf8('～', '😀')).toBeLessThan(0)
    expect('～' < '😀').toBe(false)
    expect(compareUtf8('a', 'ab')).toBeLessThan(0)
    expect(compareUtf8('B', 'b')).toBeLessThan(0)
    expect(compareUtf8('x', 'x')).toBe(0)
  })
})

describe('clock', () => {
  it('fixed and manual clocks are deterministic', () => {
    expect(fixedClock(42).nowMs()).toBe(42)
    const clock = manualClock(1000)
    clock.advance(500)
    expect(clock.nowMs()).toBe(1500)
    clock.set(0)
    expect(clock.nowMs()).toBe(0)
  })

  it('the system clock returns integer milliseconds', () => {
    expect(Number.isInteger(systemClock.nowMs())).toBe(true)
  })

  it('formats RFC 3339 UTC timestamps with millisecond precision', () => {
    expect(formatTimestamp(Date.UTC(2026, 9, 4, 12, 0, 0))).toBe('2026-10-04T12:00:00.000Z')
  })
})
