import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CliError } from './errors.ts'

/**
 * The CLI's token store (oauth.md §5, Wave 3B): one file,
 * `<config dir>/credentials.json`, readable by the owner only (0600, in a
 * 0700 directory). Writes are atomic (a new 0600 file created exclusively,
 * written, flushed and renamed over the old one), so a crash never leaves a
 * half-written file and a token never exists in a more permissive file.
 * A file that others could read, or that another user owns, is refused
 * rather than used. Tokens never appear in an error message or a log.
 *
 * A refresh rotates the refresh token, and a rotated-out token presented
 * again ends the whole grant on the server (reuse detection). Two CLI
 * processes refreshing at the same time would do exactly that, so a refresh
 * runs under an exclusive lock file and re-reads the store first.
 */
export interface StoredCredentials {
  readonly server: string
  readonly clientId: string
  readonly accessToken: string
  /** Epoch milliseconds. */
  readonly accessExpiresAt: number
  readonly refreshToken: string | null
  readonly scope: string
  readonly obtainedAt: number
}

interface StoreFile {
  readonly version: 1
  readonly credentials: Readonly<Record<string, StoredCredentials>>
}

const FILE = 'credentials.json'
const LOCK = 'credentials.lock'
const STALE_LOCK_MS = 30_000
const TOKEN = /^ex(at|rt)_[A-Za-z0-9_-]{43}$/

export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['EXPONETDB_CONFIG_DIR']
  if (explicit !== undefined && explicit.length > 0) {
    return explicit
  }
  const xdg = env['XDG_CONFIG_HOME']
  return join(xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), '.config'), 'exponetdb')
}

/** An own property of a parsed JSON value, without trusting its shape. */
export function prop(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined
}

function credentialsOf(value: unknown): StoredCredentials | undefined {
  const server = prop(value, 'server')
  const clientId = prop(value, 'clientId')
  const accessToken = prop(value, 'accessToken')
  const accessExpiresAt = prop(value, 'accessExpiresAt')
  const refreshToken = prop(value, 'refreshToken')
  const scope = prop(value, 'scope')
  const obtainedAt = prop(value, 'obtainedAt')
  if (
    typeof server !== 'string' ||
    typeof clientId !== 'string' ||
    typeof accessToken !== 'string' ||
    !TOKEN.test(accessToken) ||
    typeof accessExpiresAt !== 'number' ||
    !(refreshToken === null || (typeof refreshToken === 'string' && TOKEN.test(refreshToken))) ||
    typeof scope !== 'string' ||
    typeof obtainedAt !== 'number'
  ) {
    return undefined
  }
  return { server, clientId, accessToken, accessExpiresAt, refreshToken, scope, obtainedAt }
}

const POSIX = process.platform !== 'win32'

export class TokenStore {
  readonly dir: string

  constructor(dir: string = defaultConfigDir()) {
    this.dir = dir
  }

  get path(): string {
    return join(this.dir, FILE)
  }

  async #ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    if (POSIX) {
      const info = await stat(this.dir)
      if (
        (info.mode & 0o077) !== 0 ||
        (process.getuid !== undefined && info.uid !== process.getuid())
      ) {
        throw new CliError(
          'store_insecure',
          `The directory ${this.dir} must belong to you and be private (0700).`,
        )
      }
    }
  }

  async #load(): Promise<StoreFile> {
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(this.path)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { version: 1, credentials: {} }
      }
      throw error
    }
    if (!info.isFile()) {
      throw new CliError('store_insecure', `${this.path} is not a regular file.`)
    }
    if (
      POSIX &&
      ((info.mode & 0o077) !== 0 || (process.getuid !== undefined && info.uid !== process.getuid()))
    ) {
      throw new CliError(
        'store_insecure',
        `${this.path} is readable by others or not yours; it is not used. Remove it and sign in again.`,
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.path, 'utf8'))
    } catch {
      throw new CliError('store_corrupt', `${this.path} is not valid. Remove it and sign in again.`)
    }
    if (prop(parsed, 'version') !== 1) {
      throw new CliError('store_corrupt', `${this.path} is not valid. Remove it and sign in again.`)
    }
    const raw = prop(parsed, 'credentials')
    const credentials: Record<string, StoredCredentials> = {}
    if (typeof raw === 'object' && raw !== null) {
      for (const [server, value] of Object.entries(raw)) {
        const parsedCredentials = credentialsOf(value)
        if (parsedCredentials !== undefined && parsedCredentials.server === server) {
          credentials[server] = parsedCredentials
        }
      }
    }
    return { version: 1, credentials }
  }

  async #save(file: StoreFile): Promise<void> {
    await this.#ensureDir()
    const temp = join(this.dir, `.${FILE}.${randomBytes(8).toString('hex')}.tmp`)
    const handle = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    )
    try {
      await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temp, this.path)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
    if (POSIX) {
      const dir = await open(this.dir, constants.O_RDONLY)
      try {
        await dir.sync()
      } finally {
        await dir.close()
      }
    }
  }

  async read(server: string): Promise<StoredCredentials | undefined> {
    return (await this.#load()).credentials[server]
  }

  async servers(): Promise<string[]> {
    return Object.keys((await this.#load()).credentials)
  }

  async write(credentials: StoredCredentials): Promise<void> {
    const current = await this.#load()
    await this.#save({
      version: 1,
      credentials: { ...current.credentials, [credentials.server]: credentials },
    })
  }

  async remove(server: string): Promise<void> {
    const current = await this.#load()
    if (!(server in current.credentials)) {
      return
    }
    const { [server]: _removed, ...rest } = current.credentials
    if (Object.keys(rest).length === 0) {
      await rm(this.path, { force: true })
      return
    }
    await this.#save({ version: 1, credentials: rest })
  }

  /** Runs `fn` while holding the store's exclusive lock (another CLI process waits). */
  async withLock<T>(fn: () => Promise<T>, timeoutMs = 15_000): Promise<T> {
    await this.#ensureDir()
    const lock = join(this.dir, LOCK)
    const deadline = Date.now() + timeoutMs
    for (;;) {
      try {
        const handle = await open(
          lock,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o600,
        )
        await handle.writeFile(String(process.pid))
        await handle.close()
        break
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
          throw error
        }
        const info = await stat(lock).catch(() => undefined)
        if (info !== undefined && Date.now() - info.mtimeMs > STALE_LOCK_MS) {
          await rm(lock, { force: true })
          continue
        }
        if (Date.now() > deadline) {
          throw new CliError('store_locked', `Another exponetdb process holds ${lock}.`)
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
    try {
      return await fn()
    } finally {
      await rm(lock, { force: true })
    }
  }
}
