const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** A canonical ULID whose code point order follows `n` (`u(1) < u(2) < …`). */
export function u(n: number): string {
  let s = ''
  let v = n
  for (let i = 0; i < 23; i++) {
    s = (CROCKFORD[v % 32] ?? '0') + s
    v = Math.floor(v / 32)
  }
  return `01J${s}`
}
