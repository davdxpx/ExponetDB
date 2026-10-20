/**
 * Bundle budgets of the Web App build (Wave 8 order §10 Phase 15), checked by `postbuild.ts` on
 * the output of `vite build`. All sizes are gzip bytes at level 9, the size `serve` delivers
 * (`.gz` and `.br` are precompressed next to the file).
 *
 * - `entryJs`: all JavaScript the page loads before it renders (the `<script>` and the
 *   `modulepreload` links of `index.html`);
 * - `largestChunk`: the largest single JavaScript file, entry or lazy;
 * - `css`: all stylesheets together;
 * - `lazyChunk`: the ceiling of every lazy chunk (a route, a dialog, a library behind
 *   `import()`), except the three named heavy chunks in `heavy`, which have a ceiling of their
 *   own because they carry one large library each (charts, the SQL editor, the schema diagram).
 *
 * Each number is the measured size of the build when it was set, plus 15 percent, rounded up
 * to a whole kB. A budget moves only in a change that says why (a new library, a new screen),
 * never to get a build green.
 */

export interface Budgets {
  readonly entryJs: number
  readonly largestChunk: number
  readonly css: number
  readonly lazyChunk: number
  /** Chunk name (the file name before the content hash) to its ceiling. */
  readonly heavy: Readonly<Record<string, number>>
}

export const BUDGETS: Budgets = {
  entryJs: 268_000, // measured 232.7 kB on 2026-10-13
  largestChunk: 190_000, // section-page, 165.1 kB
  css: 35_000, // 29.8 kB
  lazyChunk: 51_000, // largest unnamed lazy chunk, app-*, 43.9 kB
  heavy: {
    'section-page': 190_000, // the target section pages with their charts, 165.1 kB
    // CodeMirror 6, shared by the SQL editor and the text diff since the migration SQL panel
    // (2026-10-20) uses the diff; Rolldown names the shared chunk after its first module. Was
    // `sql-editor` at 138.0 kB; the same library, 134.7 kB, so the ceiling is unchanged.
    'cm-untrusted': 159_000,
    'schema-erd': 85_000, // @xyflow/react and the schema diagram, 73.1 kB
  },
}

export interface BuiltFile {
  /** Path relative to the output directory, with forward slashes: `assets/chunks/x-AbC.js`. */
  readonly name: string
  readonly gzip: number
}

export interface Measured {
  readonly entryJs: number
  readonly largestChunk: { readonly name: string; readonly gzip: number }
  readonly css: number
  /** The largest lazy chunk of each name. */
  readonly lazyByName: Readonly<Record<string, number>>
}

/** `assets/chunks/sql-editor-Bb8A0_PY.js` is the chunk `sql-editor`; `assets/app.js` is `app`. */
export function chunkName(file: string): string {
  const base = file.slice(file.lastIndexOf('/') + 1).replace(/\.js$/, '')
  return base.replace(/-[A-Za-z0-9_-]{8}$/, '')
}

/** The scripts and module preloads `index.html` names: the JavaScript of the first render. */
export function entryFiles(html: string): Set<string> {
  const names = new Set<string>()
  for (const tag of html.match(/<(?:script|link)\b[^>]*>/g) ?? []) {
    if (/<link\b/.test(tag) && !/rel="modulepreload"/.test(tag)) continue
    const target = /\b(?:src|href)="([^"]+\.js)"/.exec(tag)?.[1]
    if (target !== undefined) names.add(target.replace(/^\//, ''))
  }
  return names
}

export function measure(files: readonly BuiltFile[], entry: ReadonlySet<string>): Measured {
  const scripts = files.filter((f) => f.name.endsWith('.js'))
  const largest = (list: readonly BuiltFile[]) =>
    list.reduce<BuiltFile>((a, b) => (b.gzip > a.gzip ? b : a), { name: '(none)', gzip: 0 })
  const lazyByName: Record<string, number> = {}
  for (const f of scripts) {
    if (entry.has(f.name)) continue
    lazyByName[chunkName(f.name)] = Math.max(lazyByName[chunkName(f.name)] ?? 0, f.gzip)
  }
  return {
    entryJs: scripts.filter((f) => entry.has(f.name)).reduce((sum, f) => sum + f.gzip, 0),
    largestChunk: largest(scripts),
    css: files.filter((f) => f.name.endsWith('.css')).reduce((sum, f) => sum + f.gzip, 0),
    lazyByName,
  }
}

/** The lazy chunks other than the named heavy ones, largest first. */
export function lazyCeilingCandidate(
  files: readonly BuiltFile[],
  entry: ReadonlySet<string>,
  budgets: Budgets,
): BuiltFile {
  return files
    .filter((f) => f.name.endsWith('.js') && !entry.has(f.name))
    .filter((f) => !(chunkName(f.name) in budgets.heavy))
    .reduce<BuiltFile>((a, b) => (b.gzip > a.gzip ? b : a), { name: '(none)', gzip: 0 })
}

const kb = (bytes: number): string => `${(bytes / 1000).toFixed(1)} kB`

/** The budgets a build exceeds, each as a message that names the number, the budget and the file. */
export function checkBudgets(
  files: readonly BuiltFile[],
  entry: ReadonlySet<string>,
  budgets: Budgets,
): { readonly problems: string[]; readonly report: string[] } {
  const m = measure(files, entry)
  const lazy = lazyCeilingCandidate(files, entry, budgets)
  const problems: string[] = []
  const report: string[] = []
  const line = (label: string, size: number, budget: number, file?: string) => {
    report.push(`${label}: ${kb(size)} of ${kb(budget)}${file === undefined ? '' : ` (${file})`}`)
    if (size > budget) {
      problems.push(
        `bundle budget exceeded: ${label} is ${kb(size)} gzip, the budget is ${kb(budget)}` +
          `${file === undefined ? '' : ` (${file})`}; remove weight or move it behind import(), ` +
          'and raise the budget in scripts/budgets.ts only with the reason',
      )
    }
  }
  line('entry JavaScript', m.entryJs, budgets.entryJs)
  line('largest chunk', m.largestChunk.gzip, budgets.largestChunk, m.largestChunk.name)
  line('CSS', m.css, budgets.css)
  line('largest lazy route chunk', lazy.gzip, budgets.lazyChunk, lazy.name)
  for (const [name, budget] of Object.entries(budgets.heavy)) {
    const size = m.lazyByName[name]
    if (size === undefined) {
      problems.push(
        `bundle budget names the chunk "${name}", which the build no longer has; remove it from scripts/budgets.ts`,
      )
      continue
    }
    line(`heavy chunk ${name}`, size, budget)
  }
  return { problems, report }
}
