import { constants } from 'node:fs'
import { open, unlink } from 'node:fs/promises'
import { pruneAuditPartitions, verifyAuditChain } from '@exponetdb/audit'
import {
  bootstrapPsqlScript,
  CONTROL_STORE_DATABASE,
  CONTROL_STORE_ROLES,
  type ControlStore,
  type ControlStoreRole,
  compareSchema,
  expectedMigrations,
  generatePassword,
  loadBundleSet,
  type MigrateReport,
  migrateControlStore,
  readInstallationId,
  readLedger,
  scramSha256Verifier,
} from '@exponetdb/control-store'
import { newId } from '@exponetdb/kernel'
import { ensurePostgresCa, initPki, postgresCaPem } from '@exponetdb/nodes'
import {
  addKeyToKeyringText,
  generateKeyringText,
  keyringStatus,
  loadKeyring,
} from '@exponetdb/secrets'
import { BUILD } from '../config/build-info.ts'
import type { StoreConfig } from '../config/env.ts'
import { openStore, type Runtime } from './runtime.ts'

/**
 * The operator commands' work, composed here so that `commands/` stays a
 * thin argument layer. Every command uses exactly one Control Store login and
 * refuses any other; none writes secrets to logs or to standard output except
 * the keyring commands, which write key material only to a new file with
 * mode 0600 when `--output` is given.
 */
export class CommandRefused extends Error {
  override readonly name = 'CommandRefused'
  readonly code: string
  constructor(code: string) {
    super(code)
    this.code = code
  }
}

/** The login named in a connection URL, if it is one of the Control Store roles. */
function loginOf(url: string): ControlStoreRole | undefined {
  try {
    const name = decodeURIComponent(new URL(url).username)
    return CONTROL_STORE_ROLES.find((r) => r === name)
  } catch {
    return undefined
  }
}

/** Writes a new file with mode 0600; never overwrites an existing one. */
export async function writeSecretFile(path: string, text: string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    await handle.writeFile(text, 'utf8')
  } finally {
    await handle.close()
  }
}

/** `exponetdb control-store migrate`: as `exdb_migrate` only. */
export async function migrate(config: StoreConfig, runtime: Runtime): Promise<MigrateReport> {
  const store = openStore(runtime, config.controlStoreUrl, 'exdb_migrate', 2)
  try {
    return await migrateControlStore({
      store,
      bundles: await loadBundleSet(),
      engineVersion: BUILD.version,
      newInstallationId: () => newId('ins', runtime.clock.nowMs()),
      logger: runtime.logger,
    })
  } finally {
    await store.close()
  }
}

export interface SchemaStatus {
  readonly installationId: string | null
  readonly status: string
  readonly expected: number
  readonly applied: number
}

/** `exponetdb control-store status`: read-only, with any runtime login. */
export async function schemaStatus(config: StoreConfig, runtime: Runtime): Promise<SchemaStatus> {
  const login = loginOf(config.controlStoreUrl)
  if (login === undefined || login === 'exdb_migrate') {
    throw new CommandRefused('runtime_login_required')
  }
  const store = openStore(runtime, config.controlStoreUrl, login, 1)
  try {
    await store.verifyLogin()
    const bundles = await loadBundleSet()
    const expected = expectedMigrations(bundles)
    const ledger = await readLedger(store)
    return {
      installationId: (await readInstallationId(store)) ?? null,
      status: compareSchema(expected, ledger).status,
      expected: expected.length,
      applied: ledger.entries.length,
    }
  } finally {
    await store.close()
  }
}

export interface BootstrapOutput {
  readonly script: string
  /** `role=password` lines; written only to the credentials file. */
  readonly credentials: string
}

/**
 * `exponetdb control-store bootstrap-sql`: the bootstrap script (SCRAM
 * verifiers, never passwords) and, separately, the generated passwords.
 */
export function bootstrapSql(database = CONTROL_STORE_DATABASE): BootstrapOutput {
  const passwords = Object.fromEntries(
    CONTROL_STORE_ROLES.map((role) => [role, generatePassword()]),
  )
  const verifier = (role: ControlStoreRole) => scramSha256Verifier(passwords[role] ?? '')
  const script = bootstrapPsqlScript(database, {
    exdb_migrate: verifier('exdb_migrate'),
    exdb_serve: verifier('exdb_serve'),
    exdb_worker: verifier('exdb_worker'),
    exdb_gateway: verifier('exdb_gateway'),
    exdb_audit_maint: verifier('exdb_audit_maint'),
  })
  const credentials = [
    '# ExponetDB Control Store logins. Secret: store each in its resource, keep an offline copy, delete this file.',
    ...CONTROL_STORE_ROLES.map((role) => `${role}=${passwords[role] ?? ''}`),
    '',
  ].join('\n')
  return { script, credentials }
}

export function keyringGenerate(keyId: string): string {
  return generateKeyringText(keyId)
}

export function keyringAddKey(text: string, keyId: string): string {
  return addKeyToKeyringText(text, keyId)
}

export interface KeyringReport {
  readonly activeKeyId: string
  readonly keys: readonly {
    keyId: string
    status: string
    references: number
    removable: boolean
  }[]
  readonly missing: readonly string[]
  readonly mismatched: readonly string[]
}

/** `exponetdb keyring status`: key ids and reference counts only, never key material. */
export async function keyringReport(
  config: StoreConfig & { readonly keyringEnv: Readonly<Record<string, string | undefined>> },
  runtime: Runtime,
): Promise<KeyringReport> {
  const login = loginOf(config.controlStoreUrl)
  if (login !== 'exdb_worker' && login !== 'exdb_serve' && login !== 'exdb_gateway') {
    throw new CommandRefused('process_login_required')
  }
  const keyring = await loadKeyring(config.keyringEnv)
  const store = openStore(runtime, config.controlStoreUrl, login, 1)
  try {
    await store.verifyLogin()
    const status = await keyringStatus(store, keyring)
    return {
      activeKeyId: keyring.activeKeyId,
      keys: keyring.keys.map((k) => ({
        keyId: k.keyId,
        status: k.status,
        references: status.references.get(k.keyId) ?? 0,
        removable: status.removable.includes(k.keyId),
      })),
      missing: status.missing,
      mismatched: status.mismatched,
    }
  } finally {
    keyring.destroy()
    await store.close()
  }
}

export interface NodePkiReport {
  readonly rootFingerprint: string
  readonly jobKeyId: string
  readonly gatewayUrl: string
  readonly serverName: string
  readonly rootKeyFile: string
}

/**
 * `exponetdb node-pki init` ([control-plane.md §3](../../../../exponetdb-docs/07-node-agent/control-plane.md#3-pki-bootstrap-exponetdb-node-pki-init)):
 * as the worker login only. The root key file is created first (mode 0600,
 * never over an existing file) and written inside the transaction, so a
 * failed ceremony leaves no PKI behind and removes the file; the key is
 * never printed and never stored.
 */
export async function nodePkiInit(
  config: StoreConfig & { readonly keyringEnv: Readonly<Record<string, string | undefined>> },
  runtime: Runtime,
  request: {
    readonly gatewayUrl: string
    readonly serverName: string
    readonly rootKeyOut: string
  },
): Promise<NodePkiReport> {
  if (loginOf(config.controlStoreUrl) !== 'exdb_worker') {
    throw new CommandRefused('worker_login_required')
  }
  const keyring = await loadKeyring(config.keyringEnv)
  const store = openStore(runtime, config.controlStoreUrl, 'exdb_worker', 1)
  const file = await open(
    request.rootKeyOut,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  )
  let written = false
  let attempted: { rootFingerprint: string; jobKeyId: string } | undefined
  const report = (pki: { rootFingerprint: string; jobKeyId: string }): NodePkiReport => ({
    rootFingerprint: pki.rootFingerprint,
    jobKeyId: pki.jobKeyId,
    gatewayUrl: request.gatewayUrl,
    serverName: request.serverName,
    rootKeyFile: request.rootKeyOut,
  })
  try {
    await store.verifyLogin()
    const result = await store
      .transaction('nodes.pki.init', async (tx) => {
        const pki = await initPki(tx, keyring, runtime.clock, {
          gatewayUrl: request.gatewayUrl,
          serverName: request.serverName,
        })
        await file.writeFile(pki.rootPrivateKeyPem, 'utf8')
        await file.sync()
        attempted = { rootFingerprint: pki.rootFingerprint, jobKeyId: pki.jobKeyId }
        return pki
      })
      .catch(async (error: unknown) => {
        // A commit whose answer was lost (Phase 3 review): if the PKI of
        // this ceremony is there, it committed and its root key, which
        // exists only in this file, must be kept.
        if (attempted !== undefined && (await committedRoot(store)) === attempted.rootFingerprint) {
          return attempted
        }
        throw error
      })
    written = true
    return report(result)
  } finally {
    await file.close()
    if (!written) {
      await unlink(request.rootKeyOut).catch(() => undefined)
    }
    keyring.destroy()
    await store.close()
  }
}

/**
 * `exponetdb node-pki postgres-ca` ([control-plane.md §9.5](../../../../exponetdb-docs/07-node-agent/control-plane.md#95-tls-the-postgresql-ca-od-17)):
 * as the worker login only, creates the installation's PostgreSQL CA once
 * (its key a worker-consumer secret) and returns its certificate, which goes
 * into the CA bundle of every cluster whose server certificate ExponetDB
 * issues. Run again, it prints the same certificate.
 */
export async function nodePkiPostgresCa(
  config: StoreConfig & { readonly keyringEnv: Readonly<Record<string, string | undefined>> },
  runtime: Runtime,
): Promise<{
  readonly fingerprint: string
  readonly created: boolean
  readonly certificatePem: string
}> {
  if (loginOf(config.controlStoreUrl) !== 'exdb_worker') {
    throw new CommandRefused('worker_login_required')
  }
  const keyring = await loadKeyring(config.keyringEnv)
  const store = openStore(runtime, config.controlStoreUrl, 'exdb_worker', 1)
  try {
    await store.verifyLogin()
    const ca = await ensurePostgresCa(store, keyring, runtime.clock)
    return { fingerprint: ca.fingerprint, created: ca.created, certificatePem: postgresCaPem(ca) }
  } finally {
    keyring.destroy()
    await store.close()
  }
}

/** The root fingerprint the Control Store holds, if it can be read. */
async function committedRoot(store: ControlStore): Promise<string | undefined> {
  try {
    const { rows } = await store.query(
      'nodes.pki.committed',
      'SELECT root_fingerprint FROM nodes.pki',
    )
    return rows[0]?.text('root_fingerprint')
  } catch {
    return undefined
  }
}

/** `exponetdb audit verify`: read-only recomputation, in a read-only transaction. */
export async function auditVerify(
  config: StoreConfig,
  runtime: Runtime,
  fromCheckpointSeq: number | undefined,
) {
  const login = loginOf(config.controlStoreUrl)
  if (login === undefined || login === 'exdb_migrate') {
    throw new CommandRefused('runtime_login_required')
  }
  const store = openStore(runtime, config.controlStoreUrl, login, 1)
  try {
    await store.verifyLogin()
    return await store.transaction(
      'audit.verify.command',
      (tx) => verifyAuditChain(tx, fromCheckpointSeq === undefined ? {} : { fromCheckpointSeq }),
      { readOnly: true, isolation: 'repeatable read' },
    )
  } finally {
    await store.close()
  }
}

/** `exponetdb audit prune`: as `exdb_audit_maint` only; nothing happens under the default `permanent`. */
export async function auditPrune(config: StoreConfig, runtime: Runtime, maxPartitions: number) {
  if (loginOf(config.controlStoreUrl) !== 'exdb_audit_maint') {
    throw new CommandRefused('audit_maint_login_required')
  }
  const store = openStore(runtime, config.controlStoreUrl, 'exdb_audit_maint', 1)
  try {
    await store.verifyLogin()
    const report = await pruneAuditPartitions(store, { clock: runtime.clock, maxPartitions })
    return {
      retention: report.retention,
      pruned: report.pruned.map((p) => ({
        partition: p.partition,
        rows: p.rows,
        droppedThroughSeq: p.droppedThroughSeq,
        eventSeq: p.eventSeq,
      })),
      remaining: report.remaining,
    }
  } finally {
    await store.close()
  }
}
