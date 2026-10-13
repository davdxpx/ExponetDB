import { describe, expect, it } from 'vitest'
import {
  BUDGETS,
  type Budgets,
  type BuiltFile,
  checkBudgets,
  chunkName,
  entryFiles,
} from '../../scripts/budgets.ts'

const HTML = `<!doctype html><html><head>
<script type="module" crossorigin src="/assets/app.js"></script>
<link rel="modulepreload" crossorigin href="/assets/chunks/button-DGGNObM2.js">
<link rel="stylesheet" crossorigin href="/assets/app.css">
<link rel="icon" href="/favicon.svg">
</head><body></body></html>`

const BUDGET: Budgets = {
  entryJs: 100_000,
  largestChunk: 200_000,
  css: 50_000,
  lazyChunk: 60_000,
  heavy: { 'sql-editor': 200_000 },
}

const FILES: BuiltFile[] = [
  { name: 'assets/app.js', gzip: 70_000 },
  { name: 'assets/chunks/button-DGGNObM2.js', gzip: 20_000 },
  { name: 'assets/chunks/sql-editor-Bb8A0_PY.js', gzip: 150_000 },
  { name: 'assets/chunks/account-B0V3_Xh6.js', gzip: 40_000 },
  { name: 'assets/app.css', gzip: 30_000 },
]

const ENTRY = entryFiles(HTML)

describe('the bundle budgets', () => {
  it('reads the entry from the script and the module preloads of index.html only', () => {
    expect([...ENTRY].sort()).toEqual(['assets/app.js', 'assets/chunks/button-DGGNObM2.js'])
  })

  it('names a chunk by its file name without the content hash', () => {
    expect(chunkName('assets/chunks/sql-editor-Bb8A0_PY.js')).toBe('sql-editor')
    expect(chunkName('assets/chunks/dist-3lc7BSLC.js')).toBe('dist')
    expect(chunkName('assets/app.js')).toBe('app')
  })

  it('passes a build inside every budget and reports each measured number', () => {
    const { problems, report } = checkBudgets(FILES, ENTRY, BUDGET)
    expect(problems).toEqual([])
    expect(report).toEqual([
      'entry JavaScript: 90.0 kB of 100.0 kB',
      'largest chunk: 150.0 kB of 200.0 kB (assets/chunks/sql-editor-Bb8A0_PY.js)',
      'CSS: 30.0 kB of 50.0 kB',
      'largest lazy route chunk: 40.0 kB of 60.0 kB (assets/chunks/account-B0V3_Xh6.js)',
      'heavy chunk sql-editor: 150.0 kB of 200.0 kB',
    ])
  })

  it('fails with a message that names the number, the budget and the file', () => {
    const { problems } = checkBudgets(
      [...FILES, { name: 'assets/chunks/orders-ZZZZZZZZ.js', gzip: 61_000 }],
      ENTRY,
      BUDGET,
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('largest lazy route chunk is 61.0 kB gzip')
    expect(problems[0]).toContain('the budget is 60.0 kB')
    expect(problems[0]).toContain('assets/chunks/orders-ZZZZZZZZ.js')
    expect(problems[0]).toContain('scripts/budgets.ts')
  })

  it('fails each of the four budgets on its own', () => {
    const over = (patch: Partial<Budgets>) => checkBudgets(FILES, ENTRY, { ...BUDGET, ...patch })
    expect(over({ entryJs: 89_000 }).problems.join()).toContain('entry JavaScript')
    expect(over({ largestChunk: 149_000 }).problems.join()).toContain('largest chunk')
    expect(over({ css: 29_000 }).problems.join()).toContain('CSS')
    expect(over({ lazyChunk: 39_000 }).problems.join()).toContain('largest lazy route chunk')
    expect(over({ heavy: { 'sql-editor': 149_000 } }).problems.join()).toContain(
      'heavy chunk sql-editor',
    )
  })

  it('holds a named heavy chunk to its own ceiling, not to the shared lazy one', () => {
    // sql-editor is 150 kB: far over the shared 60 kB, inside its own 200 kB.
    expect(checkBudgets(FILES, ENTRY, BUDGET).problems).toEqual([])
  })

  it('does not count an entry chunk as lazy, and fails a named chunk the build lost', () => {
    const lazyOnly = checkBudgets(FILES, ENTRY, { ...BUDGET, lazyChunk: 40_000 })
    expect(lazyOnly.problems).toEqual([])
    const lost = checkBudgets(FILES, ENTRY, { ...BUDGET, heavy: { 'schema-erd': 10_000 } })
    expect(lost.problems.join()).toContain('"schema-erd", which the build no longer has')
  })

  it('has positive budgets for the real build (a zero budget fails everything)', () => {
    expect(BUDGETS.entryJs).toBeGreaterThan(0)
    expect(BUDGETS.largestChunk).toBeGreaterThanOrEqual(BUDGETS.lazyChunk)
    expect(BUDGETS.css).toBeGreaterThan(0)
    expect(BUDGETS.lazyChunk).toBeGreaterThan(0)
    for (const budget of Object.values(BUDGETS.heavy)) {
      expect(budget).toBeLessThanOrEqual(BUDGETS.largestChunk)
    }
  })
})
