/**
 * Checks and finishes a Vite build of the Web App (ADR-0031), run after
 * `vite build` on its output directory:
 *
 * - every file is one `serve` loads (`.html` at the top, `.js .css .svg
 *   .woff2` below `assets/`), so nothing the page references can be missing;
 * - no script evaluates strings (`eval(`, `new Function(`), and no script
 *   names another origin except a short list of identifiers that are never
 *   fetched (XML namespaces, React's error decoder link inside an error
 *   message, the router's internal URL base);
 * - the JavaScript and CSS stay inside the bundle budgets of `budgets.ts` (entry JavaScript,
 *   largest chunk, CSS, lazy route chunks), with the measured numbers printed;
 * - every text file gets precompressed `.br` and `.gz` variants.
 *
 * The CSP and the browser suites remain the real barrier; this keeps
 * surprises out of the build.
 */
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import { BUDGETS, type BuiltFile, checkBudgets, entryFiles } from './budgets.ts'
import { NOTICE_FILE, verifyNoticeText } from './notices.ts'

// The directory `vite build` wrote: the argument, else `EXDB_WEB_OUT_DIR` (as `vite.config.ts`
// reads it, relative to `apps/web`), else `apps/web/dist`.
const app = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(app, process.argv[2] ?? process.env['EXDB_WEB_OUT_DIR'] ?? 'dist')

export const SERVED = new Set(['.js', '.css', '.svg', '.woff2'])

/** Packages the bundle always holds; their sections must be in the license notice. */
export const REQUIRED_NOTICES = [
  'react',
  'react-dom',
  '@tanstack/react-router',
  '@tanstack/react-query',
  '@fontsource/inter',
]
export const REQUIRED_TITLES = [
  'Files derived from Supabase and shadcn/ui',
  'Apache License 2.0 (Supabase)',
  'MIT License (shadcn/ui)',
  'CC0 1.0 Universal (Simple Icons)',
]
export const URL_ALLOWLIST = [
  'http://www.w3.org/1999/xlink',
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/1999/xhtml',
  'http://www.w3.org/2000/xmlns/',
  'http://www.w3.org/XML/1998/namespace',
  'http://www.w3.org/1998/Math/MathML',
  'https://react.dev/errors/',
  'http://localhost',
  // Text of an error message of @simplewebauthn/browser (never fetched or linked); the
  // Wave 3A build allowed the same prefix.
  'https://simplewebauthn.dev/docs/',
  // zod (form validation of the access pages): the `$schema` identifiers its JSON Schema
  // emitter writes into a document, and the template its IP address check parses with
  // `new URL` (`http://[<address>]`, a local parse). Neither is ever fetched or linked.
  'https://json-schema.org/draft/2020-12/schema',
  'http://json-schema.org/draft-07/schema#',
  'http://json-schema.org/draft-04/schema#',
  'http://[${',
  // @xyflow/react (the schema diagram, a lazy chunk): the href of its attribution panel, which
  // the diagram hides (`proOptions.hideAttribution`, packages/ui-data/src/erd/schema-erd.tsx),
  // so it is never rendered, linked or fetched. Exact literal only.
  'https://reactflow.dev/',
  'https://reactflow.dev?utm_source=attribution',
  // recharts (the charts of the target pages, a lazy chunk) bundles redux, redux-toolkit, immer
  // and a prop-types check; these are the documentation links inside their error message texts,
  // never fetched or linked. Exact literals only.
  'https://bit.ly/3cXEKWf',
  'http://fb.me/use-check-prop-types',
  // date-fns (through react-day-picker, the date picker of the target overview's custom health
  // history range, a lazy chunk): the documentation link inside the text of its error for an
  // unescaped format token, never fetched or linked. Exact literal only.
  'https://github.com/date-fns/date-fns/blob/master/docs/unicodeTokens.md',
]

/**
 * Literals whose minified variable name changes between builds, matched whole. @xyflow/react
 * (the lazy schema diagram) builds the address of its error documentation into the text of a
 * development warning, `https://${<name>}flow.dev/error#<code>`; it is never fetched or linked.
 */
export const URL_PATTERN_ALLOWLIST: readonly RegExp[] = [
  /^https:\/\/\$\{[A-Za-z_$][\w$]*\}flow\.dev\/error#\d{3}$/,
  // recharts bundles redux and redux-toolkit, whose error texts carry the code of the error.
  /^https:\/\/redux(-toolkit)?\.js\.org\/Errors\?code=\$\{[A-Za-z_$][\w$]*\}$/,
]

async function files(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await files(path)))
    else found.push(path)
  }
  return found
}

const problems: string[] = []
const all = await files(out)
for (const path of all) {
  const name = relative(out, path)
  const ext = extname(path)
  if (name === 'index.html') continue
  if (ext === '.br' || ext === '.gz') continue
  if (name === NOTICE_FILE) continue
  if (!name.startsWith('assets/') || !SERVED.has(ext)) {
    problems.push(`${name}: not a file serve delivers (ADR-0031); it would be missing at run time`)
  }
  if (ext === '.js') {
    const text = await readFile(path, 'utf8')
    if (/\beval\(|new Function\(/.test(text)) {
      problems.push(`${name}: evaluates strings`)
    }
    for (const match of text.matchAll(/https?:\/\/[^"'`\s)\\]+/g)) {
      const url = match[0]
      if (
        !URL_ALLOWLIST.some((allowed) => url === allowed || url.startsWith(allowed)) &&
        !URL_PATTERN_ALLOWLIST.some((pattern) => pattern.test(url))
      ) {
        problems.push(`${name}: names another origin: ${url}`)
      }
    }
  }
}
// The license notice: generated by the build from the bundled packages (notices-plugin.ts).
try {
  const notice = await readFile(join(out, NOTICE_FILE), 'utf8')
  const sections = [...notice.matchAll(/\n(\S+) (\S+)\nLicense: /g)].map((m) => ({
    name: m[1] ?? '',
    version: m[2] ?? '',
  }))
  const counted = /Bundled npm packages: (\d+)/.exec(notice)?.[1]
  if (counted === undefined || Number(counted) !== sections.length || sections.length === 0) {
    problems.push(`${NOTICE_FILE}: the package count does not match its sections`)
  }
  const required = REQUIRED_NOTICES.map(
    (name) => sections.find((s) => s.name === name) ?? { name, version: '?' },
  )
  problems.push(...verifyNoticeText(notice, required, REQUIRED_TITLES))
} catch {
  problems.push(`${NOTICE_FILE}: the build wrote no license notice`)
}
const built: BuiltFile[] = []
for (const path of all) {
  const ext = extname(path)
  if (ext !== '.js' && ext !== '.css') continue
  built.push({
    name: relative(out, path).split(sep).join('/'),
    gzip: gzipSync(await readFile(path), { level: 9 }).length,
  })
}
const budget = checkBudgets(
  built,
  entryFiles(await readFile(join(out, 'index.html'), 'utf8')),
  BUDGETS,
)
problems.push(...budget.problems)
for (const line of budget.report) console.log(`budget ${line}`)
if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
let compressed = 0
for (const path of all) {
  const ext = extname(path)
  if (!['.html', '.js', '.css', '.svg', '.txt'].includes(ext)) continue
  const body = await readFile(path)
  await writeFile(
    `${path}.br`,
    brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
  )
  await writeFile(`${path}.gz`, gzipSync(body, { level: 9 }))
  compressed++
}
const size = (await Promise.all(all.map((p) => stat(p)))).reduce((sum, s) => sum + s.size, 0)
console.log(`checked ${all.length} files (${size} bytes) in ${out}; precompressed ${compressed}`)
