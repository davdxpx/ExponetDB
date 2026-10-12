/**
 * The CLI's version and build. A packed release replaces the build
 * metadata at bundle time (`tooling/cli/pack.ts`); a run from source says
 * `source`. No local path or secret is ever embedded.
 */
declare const __EXPONETDB_CLI_BUILD__:
  | { readonly version: string; readonly commit: string; readonly builtAt: string }
  | undefined

export const CLI_VERSION = '0.6.0'

export const BUILD: {
  readonly version: string
  readonly commit: string
  readonly builtAt: string | null
} =
  typeof __EXPONETDB_CLI_BUILD__ === 'undefined'
    ? { version: CLI_VERSION, commit: 'source', builtAt: null }
    : __EXPONETDB_CLI_BUILD__
