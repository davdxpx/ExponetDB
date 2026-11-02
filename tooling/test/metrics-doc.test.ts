import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * VC-037: self-observability.md §3 named eleven metrics that no role registered, so the page
 * promised alerts that could not fire. Every metric the table names is registered somewhere in
 * the source or its row says `[PLANNED]`.
 */
const root = new URL('../../', import.meta.url).pathname
const doc = readFileSync(
  join(root, 'exponetdb-docs/10-observability/self-observability.md'),
  'utf8',
)

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'test') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) sources(path, out)
    else if (path.endsWith('.ts')) out.push(path)
  }
  return out
}

describe('the metrics of self-observability.md §3', () => {
  const section = doc.slice(doc.indexOf('## 3. Core metrics'), doc.indexOf('## 4. Tracing'))
  const rows = section.split('\n').filter((l) => l.startsWith('| `exdb_'))
  const code = [...sources(join(root, 'apps')), ...sources(join(root, 'packages'))]
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n')

  it('lists metrics', () => {
    expect(rows.length).toBeGreaterThanOrEqual(15)
  })

  it('registers every metric the table names, or marks its row [PLANNED]', () => {
    const unregistered = rows.flatMap((row) => {
      const names = [...(row.split('|')[1] ?? '').matchAll(/`(exdb_[a-z0-9_]+)`/g)].map((m) => m[1])
      return names
        .filter((n): n is string => n !== undefined && !code.includes(`'${n}'`))
        .filter(() => !row.includes('[PLANNED]'))
    })
    expect(unregistered).toEqual([])
  })
})
