/**
 * Builds the Web App into `dist/`: `index.html`, `app.js` (one ES module,
 * `@simplewebauthn/browser` bundled in, no source map, no external import)
 * and `app.css`. Deterministic: the same sources yield the same files. The
 * server serves them (`index.html` for the page routes, the rest under
 * `/assets/`) with the strict CSP of `apps/server/src/interfaces/http/web.ts`.
 */
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const app = join(here, '..')
const out = join(app, 'dist')

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
const result = await Bun.build({
  entrypoints: [join(app, 'src', 'main.ts')],
  outdir: out,
  naming: 'app.js',
  target: 'browser',
  format: 'esm',
  minify: true,
  sourcemap: 'none',
  conditions: ['@exponetdb/source'],
})
if (!result.success) {
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}
await copyFile(join(app, 'src', 'index.html'), join(out, 'index.html'))
await copyFile(join(app, 'src', 'app.css'), join(out, 'app.css'))

// The bundle must not name another origin or evaluate strings. Allowed: the
// SVG namespace and the library's documentation link inside a warning text.
const js = await readFile(join(out, 'app.js'), 'utf8')
const otherOrigin = /https?:\/\/(?!www\.w3\.org\/2000\/svg"|simplewebauthn\.dev\/docs\/)/
for (const forbidden of [/\beval\(/, /new Function\(/, otherOrigin]) {
  if (forbidden.test(js)) {
    console.error(`app.js contains ${forbidden}`)
    process.exit(1)
  }
}
console.log(`built the Web App into ${out} (${js.length} bytes of script)`)
