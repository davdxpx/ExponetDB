import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CliError } from './errors.ts'

/**
 * Private files of the CLI beside the token store: the same guarantees as
 * `store.ts` (a 0700 directory and 0600 files that belong to the person,
 * atomic writes, a file others could read is refused rather than used).
 * `createNewPrivateFile` writes a secret the person asked for (an enrollment
 * token, a SCRAM verifier) into a file that did not exist: it never follows
 * a link and never overwrites anything.
 */
const POSIX = process.platform !== 'win32'

export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  if (POSIX) {
    const info = await stat(dir)
    if (
      (info.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && info.uid !== process.getuid())
    ) {
      throw new CliError(
        'store_insecure',
        `The directory ${dir} must belong to you and be private (0700).`,
      )
    }
  }
}

/** A private JSON file's content, or undefined when it does not exist. */
export async function readPrivateJson(path: string): Promise<unknown> {
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
  if (!info.isFile()) throw new CliError('store_insecure', `${path} is not a regular file.`)
  if (
    POSIX &&
    ((info.mode & 0o077) !== 0 || (process.getuid !== undefined && info.uid !== process.getuid()))
  ) {
    throw new CliError(
      'store_insecure',
      `${path} is readable by others or not yours; it is not used.`,
    )
  }
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw new CliError('store_corrupt', `${path} is not valid JSON.`)
  }
}

/** Writes a private JSON file atomically (a new 0600 file renamed over the old one). */
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const dir = dirname(path)
  await ensurePrivateDir(dir)
  const temp = join(dir, `.${randomBytes(8).toString('hex')}.tmp`)
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/**
 * Creates `path` as a new 0600 file with `content` (or `mode`, e.g. 0700
 * for a script only its owner runs). Refuses an existing path (file or
 * link) and a parent directory others can write to.
 */
export async function createNewPrivateFile(
  path: string,
  content: string | Uint8Array,
  mode: 0o600 | 0o700 = 0o600,
): Promise<void> {
  const dir = dirname(path)
  if (POSIX) {
    const info = await stat(dir).catch(() => undefined)
    if (info === undefined || !info.isDirectory()) {
      throw new CliError('file_refused', `The directory ${dir} does not exist.`)
    }
    if ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0) {
      throw new CliError(
        'file_refused',
        `The directory ${dir} is writable by others; choose a private one.`,
      )
    }
  }
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (POSIX ? constants.O_NOFOLLOW : 0),
      mode,
    )
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'EEXIST' || error.code === 'ELOOP')
    ) {
      throw new CliError('file_refused', `${path} already exists; nothing was overwritten.`)
    }
    throw error
  }
  try {
    // The mode exactly, whatever the umask removed (never more than asked).
    if (POSIX && mode !== 0o600) await handle.chmod(mode)
    await handle.writeFile(content)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Checks, before anything irreversible happens (a one-time reveal), that
 * `path` can be created as a new private file: it does not exist (not even
 * as a link) and its directory is not writable by others.
 */
export async function checkNewPrivateFile(path: string): Promise<void> {
  const dir = dirname(path)
  if (POSIX) {
    const info = await stat(dir).catch(() => undefined)
    if (info === undefined || !info.isDirectory()) {
      throw new CliError('file_refused', `The directory ${dir} does not exist.`)
    }
    if ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0) {
      throw new CliError(
        'file_refused',
        `The directory ${dir} is writable by others; choose a private one.`,
      )
    }
  }
  const existing = await lstat(path).catch(() => undefined)
  if (existing !== undefined) {
    throw new CliError('file_refused', `${path} already exists; nothing is overwritten.`)
  }
}

/** A private file's text (yours, 0600 or stricter, a regular file, at most `maxBytes`). */
export async function readPrivateText(path: string, maxBytes: number): Promise<string> {
  const info = await lstat(path).catch(() => undefined)
  if (info === undefined || !info.isFile())
    throw new CliError('usage', `${path} is not a regular file.`)
  if (
    POSIX &&
    ((info.mode & 0o077) !== 0 || (process.getuid !== undefined && info.uid !== process.getuid()))
  ) {
    throw new CliError(
      'store_insecure',
      `${path} is readable by others or not yours; it is not used.`,
    )
  }
  if (info.size > maxBytes) throw new CliError('usage', `${path} is larger than ${maxBytes} bytes.`)
  return readFile(path, 'utf8')
}
