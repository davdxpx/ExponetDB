/**
 * Version ranges of `requires` ([migration-bundles.md §2](../../../../exponetdb-docs/04-migrations/migration-bundles.md)):
 * space-separated comparators (`>=16 <19`, `=0.8`, `>=0.7.0`) over dotted
 * numeric versions. `=` (or no operator) matches the given components
 * (`=16` matches 16.4); the others compare padded with zeros. A version
 * that is not dotted numeric never satisfies a range (fail closed).
 */
type Comparator = { readonly op: '>=' | '<=' | '>' | '<' | '='; readonly parts: number[] }

const NUMERIC = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*$/

function parts(version: string): number[] | null {
  return NUMERIC.test(version) ? version.split('.').map(Number) : null
}

function comparators(range: string): Comparator[] | null {
  const out: Comparator[] = []
  for (const token of range.trim().split(/\s+/)) {
    const m = /^(>=|<=|>|<|=)?(.+)$/.exec(token)
    const p = m?.[2] === undefined ? null : parts(m[2])
    if (m === null || p === null) return null
    out.push({ op: (m[1] ?? '=') as Comparator['op'], parts: p })
  }
  return out
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

export function satisfies(range: string, version: string): boolean {
  const v = parts(version)
  const cs = comparators(range)
  if (v === null || cs === null) return false
  return cs.every((c) => {
    if (c.op === '=') return c.parts.every((p, i) => v[i] === p)
    const d = compare(v, c.parts)
    return c.op === '>=' ? d >= 0 : c.op === '<=' ? d <= 0 : c.op === '>' ? d > 0 : d < 0
  })
}

/** `170002` → `17.2` (PostgreSQL 10 and later). */
export function serverVersion(versionNum: number): string {
  return `${Math.floor(versionNum / 10000)}.${versionNum % 10000}`
}
