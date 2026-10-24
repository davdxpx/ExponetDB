import { join } from 'node:path'
import { CliError } from '../errors.ts'
import { readPrivateJson, writePrivateJson } from '../files.ts'
import { parseServer } from '../oauth.ts'
import { prop } from '../store.ts'

/**
 * Profiles ([`15-cli/README.md` §3](../../../../exponetdb-docs/15-cli/README.md#3-profiles-context-and-precedence)):
 * `<config dir>/profiles.json` (0600). A profile binds a normalized server
 * origin, the installation id seen there, the authentication method and
 * non-secret defaults. It never holds a token or a key: a service account's
 * key and an API key stay in files the person names (read when needed).
 */
export type ProfileAuth =
  | {
      readonly method: 'oauth'
      /** Granted at the last sign-in; the next `login` asks for them again (15-cli §3). */
      readonly scopes?: readonly string[]
      /** Asked for at the last sign-in (to show what was not granted). */
      readonly requestedScopes?: readonly string[]
    }
  | { readonly method: 'api-key'; readonly keyFile: string }
  | {
      readonly method: 'service-account'
      readonly clientId: string
      readonly keyId: string
      readonly keyFile: string
      readonly scopes: readonly string[]
    }

export interface Profile {
  readonly name: string
  readonly server: string
  readonly installationId: string | null
  readonly auth: ProfileAuth
  readonly defaults: {
    readonly output?: 'table' | 'json' | 'ndjson'
    readonly target?: string
  }
}

export interface ProfilesFile {
  readonly version: 1
  readonly current: string | null
  readonly profiles: Readonly<Record<string, Profile>>
}

const NAME = /^[a-z][a-z0-9-]{0,31}$/

export function validProfileName(name: string): boolean {
  return NAME.test(name)
}

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : undefined

function profileOf(name: string, value: unknown): Profile | undefined {
  const server = prop(value, 'server')
  const installationId = prop(value, 'installationId')
  const auth = prop(value, 'auth')
  const defaults = prop(value, 'defaults')
  if (
    typeof server !== 'string' ||
    !(installationId === null || typeof installationId === 'string')
  ) {
    return undefined
  }
  let parsedAuth: ProfileAuth | undefined
  const method = prop(auth, 'method')
  if (method === 'oauth') {
    const scopes = strings(prop(auth, 'scopes'))
    const requestedScopes = strings(prop(auth, 'requestedScopes'))
    parsedAuth = {
      method,
      ...(scopes === undefined ? {} : { scopes }),
      ...(requestedScopes === undefined ? {} : { requestedScopes }),
    }
  } else if (method === 'api-key' && typeof prop(auth, 'keyFile') === 'string') {
    parsedAuth = { method, keyFile: String(prop(auth, 'keyFile')) }
  } else if (
    method === 'service-account' &&
    typeof prop(auth, 'clientId') === 'string' &&
    typeof prop(auth, 'keyId') === 'string' &&
    typeof prop(auth, 'keyFile') === 'string'
  ) {
    parsedAuth = {
      method,
      clientId: String(prop(auth, 'clientId')),
      keyId: String(prop(auth, 'keyId')),
      keyFile: String(prop(auth, 'keyFile')),
      scopes: strings(prop(auth, 'scopes')) ?? [],
    }
  }
  if (parsedAuth === undefined) return undefined
  const output = prop(defaults, 'output')
  const target = prop(defaults, 'target')
  return {
    name,
    server,
    installationId,
    auth: parsedAuth,
    defaults: {
      ...(output === 'table' || output === 'json' || output === 'ndjson' ? { output } : {}),
      ...(typeof target === 'string' ? { target } : {}),
    },
  }
}

export class ProfileStore {
  readonly path: string

  constructor(dir: string) {
    this.path = join(dir, 'profiles.json')
  }

  async load(): Promise<ProfilesFile> {
    const raw = await readPrivateJson(this.path)
    if (raw === undefined) return { version: 1, current: null, profiles: {} }
    if (prop(raw, 'version') !== 1) {
      throw new CliError('store_corrupt', `${this.path} is not a profiles file of this CLI.`)
    }
    const profiles: Record<string, Profile> = {}
    const listed = prop(raw, 'profiles')
    if (typeof listed === 'object' && listed !== null) {
      for (const [name, value] of Object.entries(listed)) {
        const p = validProfileName(name) ? profileOf(name, value) : undefined
        if (p !== undefined) profiles[name] = p
      }
    }
    const current = prop(raw, 'current')
    return {
      version: 1,
      current: typeof current === 'string' && current in profiles ? current : null,
      profiles,
    }
  }

  async save(file: ProfilesFile): Promise<void> {
    await writePrivateJson(this.path, file)
  }

  async put(profile: Profile, makeCurrent: boolean): Promise<void> {
    if (!validProfileName(profile.name)) {
      throw new CliError(
        'usage',
        'A profile name is lowercase letters, digits and dashes (1 to 32).',
      )
    }
    const file = await this.load()
    await this.save({
      version: 1,
      current: makeCurrent || file.current === null ? profile.name : file.current,
      profiles: {
        ...file.profiles,
        [profile.name]: { ...profile, server: parseServer(profile.server) },
      },
    })
  }

  async remove(name: string): Promise<boolean> {
    const file = await this.load()
    if (!(name in file.profiles)) return false
    const { [name]: _removed, ...rest } = file.profiles
    await this.save({
      version: 1,
      current: file.current === name ? null : file.current,
      profiles: rest,
    })
    return true
  }

  async use(name: string): Promise<void> {
    const file = await this.load()
    if (!(name in file.profiles)) throw new CliError('usage', `There is no profile ${name}.`)
    await this.save({ ...file, current: name })
  }
}
