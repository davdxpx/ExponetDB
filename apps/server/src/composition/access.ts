import { readFile } from 'node:fs/promises'
import { Application, nodeDispatchAdmission } from '@exponetdb/application'
import {
  type AuthDeps,
  Authorizer,
  accessKinds,
  bootstrapOwner,
  ControlPlaneSubjectResolver,
  checkRoleCatalog,
  InstallationKeys,
  type NotificationChannel,
  type OperatorDeps,
  oauth,
  parseAuthConfig,
  parseRecoveryReason,
  recoverOwner,
  SERVE_OPERATION_ACTOR,
} from '@exponetdb/auth'
import type { ControlStore } from '@exponetdb/control-store'
import { DRIFT_ACCEPT_KIND, diagnosticsKinds, MigrationBaselineStore } from '@exponetdb/diagnostics'
import { migrationKinds } from '@exponetdb/migrations-engine'
import {
  capabilityKinds,
  livePolicySubject,
  NODE_OPERATION_KINDS,
  nodeKinds,
} from '@exponetdb/nodes'
import {
  describeError,
  fail,
  type HealthCheck,
  pass,
  type Readiness,
} from '@exponetdb/observability'
import {
  type DispatchAdmission,
  KindRegistry,
  type OperationKind,
  WORKER_ACTOR,
} from '@exponetdb/operations'
import {
  ACCESS_RULES,
  DATA_RULES,
  MIGRATION_RULES,
  NODE_RULES,
  REGISTRY_RULES,
  RuleRegistry,
  SQL_KINDS,
  VERIFYING_KINDS,
} from '@exponetdb/policy'
import { registryChains } from '@exponetdb/registry'
import { keyringStatus } from '@exponetdb/secrets'
import { BUILD } from '../config/build-info.ts'
import type { AuthOperatorConfig, ServeConfig } from '../config/env.ts'
import {
  BACKUP_BINDINGS,
  connectorFor,
  controlStoreSystemIdentifier,
  registryKindsFor,
  registryPolicy,
} from './registry.ts'
import type { RoleServices } from './role.ts'
import { openStore, type Runtime } from './runtime.ts'

export { loadWebAssets } from './web-assets.ts'

/**
 * Wave 3A composition: the auth services, the central authorization
 * engine, the access policy rules and the use-case layer for `serve`; the
 * access operation kinds for the worker; the operator commands.
 */
export const POLICY_RULES = [
  ...ACCESS_RULES,
  ...REGISTRY_RULES,
  ...NODE_RULES,
  ...MIGRATION_RULES,
  // Wave 7 (ADR-0028 §3): who reads rows, per target.
  ...DATA_RULES,
]

/** Features this release serves (`GET /installation`); a feature is listed only when it works. */
export const INSTALLATION_FEATURES: readonly string[] = [
  'web_sessions',
  'access_management',
  'approvals',
  'oauth.authorization_code',
  'oauth.refresh_token',
  'oauth.device_code',
  'oauth.cimd',
  'oauth.dcr',
  'registry',
  'target_health',
  'schema_reads',
  'drift_checks',
  // Wave 7: POST /mcp (both protocol eras), its read tools and resources.
  'mcp',
]

export function codeVersion(): string {
  return `${BUILD.version}+${BUILD.commit}`
}

export interface AccessComposition {
  readonly application: Application
  readonly auth: AuthDeps
  /** Readiness: the stored role matrix equals this release's (refuse to authorize otherwise). */
  readonly roleCatalogCheck: HealthCheck
  /** Readiness: the stored scope catalog equals this release's (the database guards decide with it). */
  readonly scopeCatalogCheck: HealthCheck
  /** True once the role and scope catalogs were verified; the API refuses until then. */
  available(): boolean
}

export function composeAccess(
  config: ServeConfig,
  services: Pick<RoleServices, 'store' | 'keyring'> & { readonly readiness?: Readiness },
  runtime: Pick<Runtime, 'clock'> & { readonly logger?: Runtime['logger'] },
  /** Tests only: a notification channel (no channel is configured in production, OD-21). */
  testing: { readonly channel?: NotificationChannel } = {},
): AccessComposition {
  const rules = new RuleRegistry(POLICY_RULES)
  const rt = {
    store: services.store,
    keyring: services.keyring,
    clock: runtime.clock,
    installationId: config.installationId,
  }
  // serve decrypts observer secrets only; its registry kinds are for acceptance checks.
  const connector = connectorFor(rt, 'serve', { breaker: true })
  const kinds = new KindRegistry([
    ...accessKinds(services.store, runtime.clock),
    ...registryKindsFor(rt, connector),
    ...nodeKinds({ store: services.store, clock: runtime.clock }),
    // Acceptance checks only: serve signs no job.
    ...capabilityKinds(rt),
    // Acceptance checks only (observer reads): serve holds no migrator secret.
    ...migrationKinds({ ...rt, connector, engineVersion: codeVersion() }),
    // Wave 8: drift acceptance; serve checks its bindings live when a person applies it.
    ...diagnosticsKinds({
      store: services.store,
      connector,
      installationId: config.installationId,
      clock: runtime.clock,
    }),
  ])
  const policy = registryPolicy(rules, codeVersion(), runtime.clock)
  const authConfig = parseAuthConfig({
    publicUrl: config.publicUrl,
    rpId: config.webauthnRpId,
    clientRegistration: config.clientRegistration,
  })
  const auth: AuthDeps = {
    store: services.store,
    keyring: services.keyring,
    clock: runtime.clock,
    config: authConfig,
    keys: new InstallationKeys(services.store, services.keyring, runtime.clock),
    // No e-mail channel is decided (OD-21): delivery is reported as not configured.
    channel: testing.channel,
  }
  const application = new Application({
    auth,
    // Subjects resolve from the registry (Wave 4), never from a request.
    authorizer: new Authorizer(new ControlPlaneSubjectResolver(registryChains(services.store))),
    policy,
    kinds,
    ruleIds: POLICY_RULES.map((r) => r.id),
    registry: {
      plans: {
        policy,
        installationId: config.installationId,
        connector,
        controlStoreSystemIdentifier: controlStoreSystemIdentifier(services.store),
        egressAddresses: config.egressAddresses,
      },
      observation: { store: services.store, connector, installationId: config.installationId },
      // The same backup bindings as the registry kinds (registryKindsFor).
      backups: BACKUP_BINDINGS,
      // Node and cluster plans are re-checked with the tier the registry derives now (F2).
      accept: { policy, kinds, systemActor: SERVE_OPERATION_ACTOR, liveSubject: livePolicySubject },
    },
    // `GET /installation/health` (Wave 8): this process's own readiness and its keyring against the store.
    health: {
      readiness: () =>
        services.readiness?.latest() ?? {
          evaluatedAt: new Date(runtime.clock.nowMs()).toISOString(),
          checks: [],
        },
      keyring: async () => {
        const status = await keyringStatus(services.store, services.keyring)
        return { missing: status.missing.length, mismatched: status.mismatched.length }
      },
    },
    installation: {
      version: BUILD.version,
      features: INSTALLATION_FEATURES,
      installationId: config.installationId,
      oauthClientRegistration: config.clientRegistration,
    },
    // Client metadata documents go through the hardened fetcher only (oauth.md §7).
    oauth: { network: oauth.systemNetwork() },
    // A denial's audit event is written after the denial (audit.md §2); a failure is logged.
    onBackgroundError: (event, error) => runtime.logger?.error(event, { ...describeError(error) }),
  })
  let rolesVerified = false
  let scopesVerified = false
  return {
    application,
    auth,
    available: () => rolesVerified && scopesVerified,
    roleCatalogCheck: {
      name: 'role_catalog',
      severity: 'critical',
      run: async () => {
        try {
          await checkRoleCatalog(services.store)
          rolesVerified = true
          return pass()
        } catch {
          rolesVerified = false
          return fail('role_catalog_mismatch')
        }
      },
    },
    scopeCatalogCheck: {
      name: 'scope_catalog',
      severity: 'critical',
      run: async () => {
        try {
          await oauth.checkScopeCatalog(services.store)
          scopesVerified = true
          return pass()
        } catch {
          scopesVerified = false
          return fail('scope_catalog_mismatch')
        }
      },
    },
  }
}

/** The worker's access, registry and node kinds, bound to its own login (it executes, verifies and reconciles). */
export function workerKinds(
  services: Pick<RoleServices, 'store' | 'keyring'>,
  runtime: Pick<Runtime, 'clock'>,
  installationId: string,
) {
  const rt = {
    store: services.store,
    keyring: services.keyring,
    clock: runtime.clock,
    installationId,
  }
  const connector = connectorFor(rt, 'worker', { breaker: true })
  return [
    ...accessKinds(services.store, runtime.clock),
    ...registryKindsFor(rt, connector),
    ...nodeKinds({ store: services.store, clock: runtime.clock }),
    ...capabilityKinds({ ...rt, connector }),
    ...migrationKinds({
      ...rt,
      connector,
      engineVersion: codeVersion(),
      // A verified migration's schema becomes the target's expected state for drift.
      expected: new MigrationBaselineStore({
        store: services.store,
        connector,
        installationId,
      }),
    }),
    // Wave 8: the worker records an accepted drift as the target's baseline.
    ...diagnosticsKinds({ store: services.store, connector, installationId, clock: runtime.clock }),
  ]
}

/**
 * The worker's dispatch admission (Wave 5 correction F2): node and cluster
 * operations start only while their policy, re-evaluated with the current
 * tier, and the approvals their plan requires still hold. The same rules
 * as `serve`'s acceptance.
 */
export function workerDispatchAdmission(
  kinds: readonly OperationKind[],
  runtime: Pick<Runtime, 'clock'>,
): DispatchAdmission {
  return nodeDispatchAdmission(
    {
      policy: registryPolicy(POLICY_RULES, codeVersion(), runtime.clock),
      kinds: new KindRegistry(kinds),
      systemActor: WORKER_ACTOR,
      liveSubject: livePolicySubject,
    },
    // Migrations as well: an approval revoked or a tier changed after acceptance stops them here;
    // and a drift acceptance (Wave 8), whose production approval must still hold when it starts.
    [...NODE_OPERATION_KINDS, ...SQL_KINDS, ...VERIFYING_KINDS, DRIFT_ACCEPT_KIND],
    // The plan's subject as serve's authorizer resolves it, read in the dispatch transaction.
    (q) => new ControlPlaneSubjectResolver(registryChains(q)),
  )
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
