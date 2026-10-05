import { err, ok, type Result } from './result.ts'

const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const encoder = new TextEncoder()

/**
 * Decodes well-formed UTF-8 (no overlong forms, no surrogate code points,
 * nothing above U+10FFFF). A leading byte order mark is kept as U+FEFF so the
 * caller can refuse it explicitly.
 */
export function decodeUtf8(bytes: Uint8Array): Result<string, 'invalid_utf8'> {
  try {
    return ok(strictDecoder.decode(bytes))
  } catch {
    return err('invalid_utf8')
  }
}

/** Encodes a well-formed string as UTF-8. Callers must not pass lone surrogates. */
export function encodeUtf8(text: string): Uint8Array {
  return encoder.encode(text)
}

/** Compares two strings by their UTF-8 bytes, which equals code point order. */
export function compareUtf8(a: string, b: string): number {
  const x = encoder.encode(a)
  const y = encoder.encode(b)
  const n = Math.min(x.length, y.length)
  for (let i = 0; i < n; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) {
      return d
    }
  }
  return x.length - y.length
}
