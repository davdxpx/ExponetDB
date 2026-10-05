/**
 * Build identity (version and commit) of this program. The bundler replaces
 * the two identifiers below with string literals (`scripts/bundle.ts`, from
 * `package.json` and the commit being built); an unbundled run (tests,
 * `bun src/main.ts`) reports a development identity. The identity appears in
 * logs, heartbeats, `exponetdb version` and the policy version; never a
 * build time, so that the same commit builds the same image.
 */
declare const EXPONETDB_BUILD_VERSION: string | undefined
declare const EXPONETDB_BUILD_COMMIT: string | undefined

const VERSION = /^[0-9A-Za-z.+-]{1,64}$/
const COMMIT = /^(?:[0-9a-f]{7,40}|unknown)$/

function injected(read: () => string | undefined, pattern: RegExp, fallback: string): string {
  try {
    const value = read()
    return typeof value === 'string' && pattern.test(value) ? value : fallback
  } catch {
    return fallback
  }
}

export const BUILD = {
  version: injected(() => EXPONETDB_BUILD_VERSION, VERSION, '0.0.0-dev'),
  commit: injected(() => EXPONETDB_BUILD_COMMIT, COMMIT, 'unknown'),
} as const

/** `<version>+<commit>`: the code version of the policy engine (pv1). */
export const CODE_VERSION = `${BUILD.version}+${BUILD.commit}`
