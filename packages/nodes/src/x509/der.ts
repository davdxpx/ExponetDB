/**
 * A minimal DER encoder (ITU-T X.690) for the fixed certificate profiles of
 * certificate.ts. It encodes only; the Control Plane parses no ASN.1
 * (ADR-0024 §2).
 */

export type Der = Uint8Array

function lengthBytes(n: number): number[] {
  if (n < 0x80) {
    return [n]
  }
  const out: number[] = []
  for (let v = n; v > 0; v = Math.floor(v / 256)) {
    out.unshift(v % 256)
  }
  return [0x80 | out.length, ...out]
}

export function tlv(tag: number, ...contents: Der[]): Der {
  const length = contents.reduce((n, c) => n + c.length, 0)
  const head = [tag, ...lengthBytes(length)]
  const out = new Uint8Array(head.length + length)
  out.set(head, 0)
  let at = head.length
  for (const c of contents) {
    out.set(c, at)
    at += c.length
  }
  return out
}

export const sequence = (...items: Der[]): Der => tlv(0x30, ...items)
export const set = (...items: Der[]): Der => tlv(0x31, ...items)
export const explicit = (n: number, ...items: Der[]): Der => tlv(0xa0 | n, ...items)

/** A non-negative INTEGER from big-endian bytes (minimal, with a leading zero when the high bit is set). */
export function unsignedInteger(bytes: Uint8Array): Der {
  let start = 0
  while (start < bytes.length - 1 && bytes[start] === 0) {
    start++
  }
  const body = bytes.subarray(start)
  const pad = (body[0] ?? 0) & 0x80 ? [0] : []
  return tlv(0x02, new Uint8Array([...pad, ...body]))
}

export function smallInteger(n: number): Der {
  if (!Number.isInteger(n) || n < 0 || n > 127) {
    throw new RangeError('small integer out of range')
  }
  return tlv(0x02, new Uint8Array([n]))
}

export const boolean = (value: boolean): Der => tlv(0x01, new Uint8Array([value ? 0xff : 0x00]))

export function oid(dotted: string): Der {
  const parts = dotted.split('.').map((p) => Number(p))
  const [a, b, ...rest] = parts
  if (a === undefined || b === undefined || parts.some((p) => !Number.isSafeInteger(p) || p < 0)) {
    throw new RangeError(`not an OID: ${dotted}`)
  }
  const bytes: number[] = [a * 40 + b]
  for (const p of rest) {
    const chunk: number[] = [p & 0x7f]
    for (let v = Math.floor(p / 128); v > 0; v = Math.floor(v / 128)) {
      chunk.unshift(0x80 | (v & 0x7f))
    }
    bytes.push(...chunk)
  }
  return tlv(0x06, new Uint8Array(bytes))
}

export const octetString = (bytes: Uint8Array): Der => tlv(0x04, bytes)
export const bitString = (bytes: Uint8Array, unusedBits = 0): Der =>
  tlv(0x03, new Uint8Array([unusedBits, ...bytes]))
export const utf8String = (s: string): Der => tlv(0x0c, new TextEncoder().encode(s))

/** RFC 5280 §4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050; seconds, Z. */
export function time(t: Date): Der {
  const iso = t.toISOString()
  const year = t.getUTCFullYear()
  const digits = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`
  return year >= 1950 && year <= 2049
    ? tlv(0x17, new TextEncoder().encode(digits.slice(2)))
    : tlv(0x18, new TextEncoder().encode(digits))
}

/** An implicitly tagged context-specific primitive ([n] IMPLICIT). */
export const implicit = (n: number, bytes: Uint8Array): Der => tlv(0x80 | n, bytes)
