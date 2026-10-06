import { readdir, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Application } from '@exponetdb/application'
import {
  type AuthDeps,
  Authorizer,
  accessKinds,
  bootstrapOwner,
  ControlPlaneSubjectResolver,
  checkRoleCatalog,
  InstallationKeys,
  type OperatorDeps,
  parseAuthConfig,
  parseRecoveryReason,
  recoverOwner,
} from '@exponetdb/auth'
import type { ControlStore } from '@exponetdb/control-store'
import { fail, type HealthCheck, pass } from '@exponetdb/observability'
import { KindRegistry } from '@exponetdb/operations'
import { ACCESS_RULES, RuleRegistry } from '@exponetdb/policy'
import { BUILD } from '../config/build-info.ts'
import type { AuthOperatorConfig, ServeConfig } from '../config/env.ts'
import type { WebAssets } from '../interfaces/http/web.ts'
import type { RoleServices } from './role.ts'
import { openStore, type Runtime } from './runtime.ts'

/**
 * Wave 3A composition: the auth services, the central authorization
 * engine, the access policy rules and the use-case layer for `serve`; the
 * access operation kinds for the worker; the operator commands.
 */
export const POLICY_RULES = ACCESS_RULES

/** Features this release serves (`GET /installation`); a feature is listed only when it works. */
export const INSTALLATION_FEATURES: readonly string[] = [
  'web_sessions',
  'access_management',
  'approvals',
  'oauth.authorization_code',
  'oauth.refresh_token',
]

export function codeVersion(): string {
  return `${BUILD.version}+${BUILD.commit}`
}

export interface AccessComposition {
  readonly application: Application
  readonly auth: AuthDeps
  /** Readiness: the stored role matrix equals this release's (refuse to authorize otherwise). */
  readonly roleCatalogCheck: HealthCheck
  /** True once the role catalog was verified; the API refuses until then. */
  available(): boolean
}

export function composeAccess(
  config: ServeConfig,
  services: Pick<RoleServices, 'store' | 'keyring'>,
  runtime: Pick<Runtime, 'clock'>,
): AccessComposition {
  const authConfig = parseAuthConfig({ publicUrl: config.publicUrl, rpId: config.webauthnRpId })
  const auth: AuthDeps = {
    store: services.store,
    keyring: services.keyring,
    clock: runtime.clock,
    config: authConfig,
    keys: new InstallationKeys(services.store, services.keyring, runtime.clock),
    // No e-mail channel is decided in Wave 3A: delivery is reported as not configured.
    channel: undefined,
  }
  const application = new Application({
    auth,
    authorizer: new Authorizer(new ControlPlaneSubjectResolver()),
    policy: {
      registry: new RuleRegistry(POLICY_RULES),
      codeVersion: codeVersion(),
      clock: runtime.clock,
    },
    kinds: new KindRegistry(accessKinds(services.store, runtime.clock)),
    ruleIds: POLICY_RULES.map((r) => r.id),
    installation: { version: BUILD.version, features: INSTALLATION_FEATURES },
  })
  let verified = false
  return {
    application,
    auth,
    available: () => verified,
    roleCatalogCheck: {
      name: 'role_catalog',
      severity: 'critical',
      run: async () => {
        try {
          await checkRoleCatalog(services.store)
          verified = true
          return pass()
        } catch {
          verified = false
          return fail('role_catalog_mismatch')
        }
      },
    },
  }
}

/** The worker's access kinds, bound to its own login (it executes, verifies and reconciles). */
export function workerKinds(store: ControlStore, runtime: Pick<Runtime, 'clock'>) {
  return accessKinds(store, runtime.clock)
}

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

/**
 * The built Web App: next to the bundle in the image (`/app/web`), or
 * `apps/web/dist` in a workspace. Absent assets leave the API without a
 * page (logged by the caller), never a broken page.
 */
export async function loadWebAssets(
  directories?: readonly string[],
): Promise<WebAssets | undefined> {
  const candidates = directories ?? [
    fileURLToPath(new URL('../web/', import.meta.url)),
    fileURLToPath(new URL('../../../web/dist/', import.meta.url)),
  ]
  for (const dir of candidates) {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    if (!names.includes('index.html')) {
      continue
    }
    const assets = new Map<string, { body: Uint8Array; type: string }>()
    for (const name of names) {
      const type = TYPES[extname(name)]
      if (type === undefined || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) {
        continue
      }
      assets.set(name, { body: new Uint8Array(await readFile(join(dir, name))), type })
    }
    return assets
  }
  return undefined
}

function operatorDeps(
  config: AuthOperatorConfig,
  runtime: Runtime,
): OperatorDeps & { store: ControlStore } {
  return {
    store: openStore(runtime, config.controlStoreUrl, 'exdb_serve', 2),
    clock: runtime.clock,
    config: parseAuthConfig({ publicUrl: config.publicUrl, rpId: config.webauthnRpId }),
    channel: undefined,
  }
}

/** `exponetdb bootstrap owner`: the setup link goes to standard output only. */
export async function bootstrapOwnerCommand(
  config: AuthOperatorConfig,
  runtime: Runtime,
  input: { readonly email: string; readonly displayName?: string; readonly reissue: boolean },
) {
  const deps = operatorDeps(config, runtime)
  try {
    return await bootstrapOwner(deps, input)
  } finally {
    await deps.store.close()
  }
}

/** `exponetdb auth recover-owner`: the reason comes from a file, the link goes to standard output only. */
export async function recoverOwnerCommand(
  config: AuthOperatorConfig,
  runtime: Runtime,
  input: { readonly email: string; readonly reasonFile: string },
) {
  const text = await readFile(input.reasonFile, 'utf8')
  const reason = parseRecoveryReason(text.length > 8192 ? '' : text)
  const deps = operatorDeps(config, runtime)
  try {
    return await recoverOwner(deps, { email: input.email, reason })
  } finally {
    await deps.store.close()
  }
}
