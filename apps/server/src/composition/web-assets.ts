import { lstat, readdir, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WebAsset, WebAssets } from '../interfaces/http/web.ts'

/** The only file types served from the built Web App. */
const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  // Only the generated license notice is a text file (`NOTICE_KEY`).
  '.txt': 'text/plain; charset=utf-8',
}

/** The generated license notice, `assets/third-party-licenses.txt`: the one `.txt` file served. */
const NOTICE_KEY = 'third-party-licenses.txt'

/** One path segment of a served file: what content hashes and file names need, nothing else. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** Directories below `assets/` (`chunks/`, `files/`, one more level at most). */
const MAX_DEPTH = 3

async function bytes(path: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await readFile(path))
}

async function regularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch {
    return false
  }
}

/** A served file with the precompressed variants built next to it. */
async function asset(path: string, type: string): Promise<WebAsset> {
  const br = (await regularFile(`${path}.br`)) ? await bytes(`${path}.br`) : undefined
  const gzip = (await regularFile(`${path}.gz`)) ? await bytes(`${path}.gz`) : undefined
  const encodings = {
    ...(br === undefined ? {} : { br }),
    ...(gzip === undefined ? {} : { gzip }),
  }
  return {
    body: await bytes(path),
    type,
    ...(br === undefined && gzip === undefined ? {} : { encodings }),
  }
}

/** Collects the servable files below `dir` into `into`, keyed by `prefix` + their relative path. */
async function collect(
  dir: string,
  prefix: string,
  depth: number,
  into: Map<string, WebAsset>,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    // Symbolic links, sockets and the like are never followed or served.
    if (!SEGMENT.test(entry.name)) {
      continue
    }
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) {
        await collect(path, `${prefix}${entry.name}/`, depth + 1, into)
      }
      continue
    }
    const type = TYPES[extname(entry.name)]
    const key = `${prefix}${entry.name}`
    if (
      !entry.isFile() ||
      type === undefined ||
      type.startsWith('text/html') ||
      (extname(entry.name) === '.txt' && key !== NOTICE_KEY)
    ) {
      continue
    }
    if (into.has(key)) {
      throw new Error(`the built Web App holds ${key} twice`)
    }
    into.set(key, await asset(path, type))
  }
}

/**
 * The built Web App: next to the bundle in the image (`/app/web`), or
 * `apps/web/dist` in a workspace. `index.html` at the top, the assets in
 * `assets/` (served below `/assets/`); files directly next to
 * `index.html` are served below `/assets/` too (the flat layout of the
 * Wave 3A build). Only regular files with an allowed type and name are
 * loaded, once, at start; requests never touch the file system. Absent
 * assets leave the API without a page (logged by the caller), never a
 * broken page.
 */
export async function loadWebAssets(
  directories?: readonly string[],
): Promise<WebAssets | undefined> {
  const candidates = directories ?? [
    fileURLToPath(new URL('../web/', import.meta.url)),
    fileURLToPath(new URL('../../../web/dist/', import.meta.url)),
  ]
  for (const dir of candidates) {
    if (!(await regularFile(join(dir, 'index.html')))) {
      continue
    }
    const assets = new Map<string, WebAsset>()
    assets.set('index.html', await asset(join(dir, 'index.html'), 'text/html; charset=utf-8'))
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.name === 'assets' && entry.isDirectory()) {
        await collect(path, '', 1, assets)
        continue
      }
      const type = TYPES[extname(entry.name)]
      if (
        !entry.isFile() ||
        !SEGMENT.test(entry.name) ||
        type === undefined ||
        type.startsWith('text/html') ||
        extname(entry.name) === '.txt'
      ) {
        continue
      }
      if (assets.has(entry.name)) {
        throw new Error(`the built Web App holds ${entry.name} twice`)
      }
      assets.set(entry.name, await asset(path, type))
    }
    return assets
  }
  return undefined
}
