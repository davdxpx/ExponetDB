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
 * - every text file gets precompressed `.br` and `.gz` variants.
 *
 * The CSP and the browser suites remain the real barrier; this keeps
 * surprises out of the build.
 */
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

const out = process.argv[2]
if (out === undefined) {
  console.error('usage: bun scripts/postbuild.ts <output directory>')
  process.exit(2)
}

export const SERVED = new Set(['.js', '.css', '.svg', '.woff2'])
export const URL_ALLOWLIST = [
  'http://www.w3.org/1999/xlink',
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/XML/1998/namespace',
  'http://www.w3.org/1998/Math/MathML',
  'https://react.dev/errors/',
  'http://localhost',
  // Text of an error message of @simplewebauthn/browser (never fetched or linked); the
  // Wave 3A build allowed the same prefix.
  'https://simplewebauthn.dev/docs/',
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
      if (!URL_ALLOWLIST.some((allowed) => url === allowed || url.startsWith(allowed))) {
        problems.push(`${name}: names another origin: ${url}`)
      }
    }
  }
}
if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
let compressed = 0
for (const path of all) {
  const ext = extname(path)
  if (!['.html', '.js', '.css', '.svg'].includes(ext)) continue
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
