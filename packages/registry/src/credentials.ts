import { appendAuditEvent } from '@exponetdb/audit'
import type { AccessRole } from '@exponetdb/contracts'
import type { ControlStore, Queryable, Tx } from '@exponetdb/control-store'
import { type Clock, newId, parseId } from '@exponetdb/kernel'
import { ROLE_NAMES, sql, TargetError } from '@exponetdb/postgres'
import { addSecretVersion, createSecret, type Keyring } from '@exponetdb/secrets'
import { type Connector, consumerOf } from './connect.ts'
import { conflict, RegistryError } from './errors.ts'
import type { RegistryActor } from './policy.ts'
import { getCluster, latestCredential, listDatabases } from './reads.ts'
import { type CredentialRecord, credentialFrom, ts } from './records.ts'

/**
 * ExponetDB's PostgreSQL credentials on external clusters
 * ([credentials-and-roles.md](../../../exponetdb-docs/03-database-model/credentials-and-roles.md),
 * [registry.md §2.2](../../../exponetdb-docs/02-control-plane/registry.md#22-external-cluster-no-agent)).
 *
 * Submission (`serve`, Web App, re-authentication): the password a person
 * set with `\password` is encrypted at once into the consumer table of the
 * role (`observer` for the observer, `worker` for every other role, which
 * serve may insert into but never read) as the next version of the role's
 * `pg_credential` secret, and recorded `pending`. A pending submission of
 * the same role is superseded. The password never reaches a log, an
 * error, the audit or a response, and nothing returns it.
 *
 * Verification (worker task): a login as the role over verified TLS to the
 * cluster (its pinned `system_identifier` once confirmed), then the role's
 * attributes must be exactly the documented least privilege. Success
 * activates the credential and retires the one it replaces in the same
 * transaction; a definite failure fails it with a reason; an unreachable
 * cluster leaves it pending for the next round (at most a day).
 */
export interface SubmissionInput {
  readonly clusterId: string
  readonly role: AccessRole
  readonly password: string
}

export interface SubmissionDeps {
  readonly keyring: Keyring
  readonly clock: Clock
}

const CREDENTIAL_COLUMNS = `c.credential_id, c.cluster_id, c.access_role, c.role_name, c.secret_id, c.secret_version,
  c.state, ${ts('c.submitted_at')}, c.submitted_by, ${ts('c.verified_at')}, c.failure_code, ${ts('c.state_changed_at')}`

export async function submitCredential(
  tx: Tx,
  deps: SubmissionDeps,
  actor: RegistryActor,
  input: SubmissionInput,
  request: { readonly requestId?: string } = {},
): Promise<CredentialRecord> {
  const cluster = await getCluster(tx, input.clusterId)
  if (cluster === undefined) {
    throw new RegistryError('NOT_FOUND')
  }
  if (cluster.state === 'retired') {
    throw conflict('cluster_retired')
  }
  // Only the observer can be verified before the cluster's identity is pinned;
  // every other role waits for the confirmation.
  if (cluster.state !== 'active' && input.role !== 'observer') {
    throw conflict('cluster_not_confirmed')
  }
  const roleName = ROLE_NAMES[input.role]
  const plaintext = Buffer.from(input.password, 'utf8')
  try {
    const latest = await latestCredential(tx, input.clusterId, input.role)
    const ref =
      latest === undefined
        ? await createSecret(
            tx,
            deps.keyring,
            {
              purpose: 'pg_credential',
              subjectId: `${input.clusterId}/${roleName}`,
              consumer: consumerOf(input.role),
              plaintext,
            },
            { clock: deps.clock },
          )
        : await addSecretVersion(
            tx,
            deps.keyring,
            (() => {
              const id = parseId('sec', latest.secretId)
              if (!id.ok) throw new RegistryError('INTERNAL')
              return id.value
            })(),
            plaintext,
          )
    await tx.query(
      'registry.credentials.supersede',
      `UPDATE registry.credentials SET state = 'failed', failure_code = 'superseded'
        WHERE cluster_id = $1 AND access_role = $2 AND state = 'pending'`,
      [input.clusterId, input.role],
    )
    const credentialId = newId('crd', deps.clock.nowMs())
    const { rows } = await tx.query(
      'registry.credentials.insert',
      `INSERT INTO registry.credentials AS c (credential_id, cluster_id, access_role, role_name, secret_id,
                                              secret_version, state, submitted_at, submitted_by, state_changed_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', clock_timestamp(), $7, clock_timestamp())
       RETURNING ${CREDENTIAL_COLUMNS}`,
      [
        credentialId,
        input.clusterId,
        input.role,
        roleName,
        ref.secretId,
        ref.version,
        actor.identityId,
      ],
    )
    const row = rows[0]
    if (row === undefined) {
      throw new RegistryError('INTERNAL')
    }
    await appendAuditEvent(
      tx,
      {
        action: 'registry.credential.submitted',
        phase: 'completed',
        actor: {
          kind: 'human',
          identityId: actor.identityId,
          label: actor.label as never,
          reauthAt: actor.reauthAt,
        },
        client: { clientId: actor.clientId ?? null, kind: actor.client ?? 'web' },
        subject: { clusterId: input.clusterId as never },
        changes: { credentialId, role: input.role, version: ref.version, state: 'pending' },
        result: { status: 'succeeded', applyOutcome: 'applied', verificationOutcome: 'pending' },
        ...(request.requestId === undefined
          ? {}
          : { request: { requestId: request.requestId as never } }),
      },
      { clock: deps.clock },
    )
    return credentialFrom(row)
  } finally {
    plaintext.fill(0)
  }
}

// ----- verification (worker) -----

/** The documented least privilege of each role (credentials-and-roles.md §2). */
const ROLE_FACTS = sql`SELECT r.rolname, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication,
       r.rolbypassrls, r.rolcanlogin,
       EXISTS (SELECT 1 FROM pg_catalog.pg_roles s
                WHERE s.rolsuper AND pg_catalog.pg_has_role(r.oid, s.oid, 'MEMBER')) AS member_of_superuser,
       (SELECT pg_catalog.json_agg(m.rolname || ':' || CASE WHEN a.inherit_option THEN 'i' ELSE '-' END
                                   || CASE WHEN a.set_option THEN 's' ELSE '-' END ORDER BY m.rolname)
          FROM pg_catalog.pg_auth_members a JOIN pg_catalog.pg_roles m ON m.oid = a.roleid
         WHERE a.member = r.oid) AS memberships,
       (SELECT pg_catalog.json_agg(x.rolname ORDER BY x.rolname) FROM pg_catalog.pg_roles x
         WHERE x.oid <> r.oid AND pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')) AS reaches
  FROM pg_catalog.pg_roles r WHERE r.rolname = session_user`

/**
 * Memberships as `<role>:<inherit><set>` (PostgreSQL 16+ membership
 * options): the predefined roles are inherited and never `SET`; the
 * migrator may only `SET ROLE` to the ledger owner and inherits nothing.
 */
export const EXPECTED_MEMBERSHIPS: Readonly<Record<AccessRole, readonly string[]>> = {
  observer: ['pg_monitor:i-'],
  reader: ['pg_read_all_data:i-'],
  verifier: ['pg_read_all_data:i-'],
  operator: ['pg_monitor:i-', 'pg_signal_backend:i-'],
  migrator: ['exponetdb_ledger_owner:-s'],
}

/**
 * Every role each role may reach through its memberships, directly or
 * through the predefined roles' own memberships (the same on PostgreSQL 16,
 * 17 and 18): a role granted to one of these (say `pg_write_all_data` to
 * `pg_monitor`) would widen ExponetDB's role without changing its direct
 * memberships.
 */
export const EXPECTED_REACH: Readonly<Record<AccessRole, readonly string[]>> = {
  observer: ['pg_monitor', 'pg_read_all_settings', 'pg_read_all_stats', 'pg_stat_scan_tables'],
  reader: ['pg_read_all_data'],
  verifier: ['pg_read_all_data'],
  operator: [
    'pg_monitor',
    'pg_read_all_settings',
    'pg_read_all_stats',
    'pg_signal_backend',
    'pg_stat_scan_tables',
  ],
  migrator: ['exponetdb_ledger_owner'],
}

export type VerificationResult =
  | { readonly status: 'active' }
  | { readonly status: 'failed'; readonly failureCode: string }
  | { readonly status: 'pending'; readonly reason: string }

/**
 * What a refused login means for a pending credential. A server that asked
 * for the password in cleartext or as MD5 (`password` or `md5` in
 * `pg_hba.conf`) got nothing: `authentication_method`, told apart from a
 * wrong password (`authentication_failed`) so the operator knows what to fix.
 */
export function refusedLogin(error: TargetError): VerificationResult {
  switch (error.code) {
    case 'TARGET_CREDENTIAL_INVALID':
      return {
        status: 'failed',
        failureCode:
          error.reason === 'superuser_login'
            ? 'role_attributes'
            : error.reason === 'auth_method'
              ? 'authentication_method'
              : 'authentication_failed',
      }
    case 'TARGET_TLS_FAILED':
      return { status: 'failed', failureCode: 'tls_failed' }
    case 'CLUSTER_IDENTITY_MISMATCH':
      return { status: 'failed', failureCode: 'cluster_identity_mismatch' }
    case 'TARGET_UNAVAILABLE':
      return { status: 'pending', reason: error.reason }
    default:
      return { status: 'failed', failureCode: 'not_verified' }
  }
}

/** Logs in with a pending credential and checks the role; never changes the target. */
export async function verifyCredentialLogin(
  connector: Connector,
  store: ControlStore,
  credential: CredentialRecord,
): Promise<VerificationResult> {
  const cluster = await getCluster(store, credential.clusterId)
  if (cluster === undefined || cluster.state === 'retired') {
    return { status: 'failed', failureCode: 'not_verified' }
  }
  if (cluster.state !== 'active' && credential.accessRole !== 'observer') {
    // Before confirmation only the observer reads (to show the identifier to pin);
    // every other role waits for the pinned identifier.
    return { status: 'pending', reason: 'cluster_not_confirmed' }
  }
  const databases = (await listDatabases(store, credential.clusterId)).filter(
    (d) => d.state === 'registered',
  )
  const database = databases[0]?.name ?? 'postgres'
  let opened: Awaited<ReturnType<Connector['open']>>
  try {
    opened = await connector.open({
      clusterId: credential.clusterId,
      database,
      role: credential.accessRole,
      purpose: `credential/${credential.credentialId}`,
      identity: cluster.state === 'active' ? 'pinned' : 'unpinned',
      credential: { secretId: credential.secretId, version: credential.secretVersion },
    })
  } catch (error) {
    if (error instanceof TargetError) return refusedLogin(error)
    if (error instanceof RegistryError && error.code === 'REGISTRY_CONFLICT') {
      return { status: 'pending', reason: 'no_endpoint' }
    }
    throw error
  }
  try {
    const row = (await opened.session.query(ROLE_FACTS))[0]
    const memberships =
      row?.jsonArray('memberships').filter((v): v is string => typeof v === 'string') ?? []
    const reaches =
      row?.jsonArray('reaches').filter((v): v is string => typeof v === 'string') ?? []
    const expected = EXPECTED_MEMBERSHIPS[credential.accessRole]
    const bypass = credential.accessRole === 'reader' || credential.accessRole === 'verifier'
    const ok =
      row !== undefined &&
      row.text('rolname') === credential.roleName &&
      row.bool('rolcanlogin') &&
      !row.bool('rolsuper') &&
      !row.bool('rolcreatedb') &&
      !row.bool('rolcreaterole') &&
      !row.bool('rolreplication') &&
      row.bool('rolbypassrls') === bypass &&
      !row.bool('member_of_superuser') &&
      expected.every((m) => memberships.includes(m)) &&
      memberships.every((m) => expected.includes(m)) &&
      reaches.every((m) => EXPECTED_REACH[credential.accessRole].includes(m))
    return ok ? { status: 'active' } : { status: 'failed', failureCode: 'role_attributes' }
  } finally {
    await opened.session.close()
  }
}

export interface VerificationTaskDeps {
  readonly store: ControlStore
  readonly connector: Connector
  readonly clock: Clock
  /** How long a credential may wait for an unreachable cluster (default one day). */
  readonly maxPendingMs?: number
  /**
   * A pending credential another owner decides (a password ExponetDB set
   * itself through the node, Wave 5 correction F4), with the active
   * credential its activation may replace. Such a credential is activated
   * only when a login with it succeeds and only in place of that credential;
   * a failed or impossible login never fails it here: the password may
   * already be the host's, and its owner decides on evidence.
   */
  readonly owned?: (
    q: Queryable,
    credential: CredentialRecord,
  ) => Promise<{ readonly replaces: string | null } | undefined>
}

/**
 * One round of the worker's credential verification: every pending
 * credential, oldest first, at most `limit`. Rows another worker is
 * verifying are skipped (`SKIP LOCKED`). Returns what happened per
 * credential (ids and states only).
 */
export async function verifyPendingCredentials(
  deps: VerificationTaskDeps,
  limit = 20,
): Promise<{ readonly credentialId: string; readonly state: string }[]> {
  const { rows } = await deps.store.query(
    'registry.credentials.pending',
    `SELECT ${CREDENTIAL_COLUMNS} FROM registry.credentials c
      WHERE c.state = 'pending' ORDER BY c.submitted_at LIMIT $1`,
    [Math.min(Math.max(1, limit), 200)],
  )
  const out: { credentialId: string; state: string }[] = []
  for (const credential of rows.map(credentialFrom)) {
    // One credential that cannot be decided never holds up the others
    // (correction review): it stays pending and is reported.
    try {
      out.push(await verifyOne(deps, credential))
    } catch {
      out.push({ credentialId: credential.credentialId, state: 'error' })
    }
  }
  return out
}

async function verifyOne(
  deps: VerificationTaskDeps,
  credential: CredentialRecord,
): Promise<{ readonly credentialId: string; readonly state: string }> {
  {
    const owner = await deps.owned?.(deps.store, credential)
    if (owner !== undefined) {
      const result = await verifyCredentialLogin(deps.connector, deps.store, credential)
      const activated =
        result.status === 'active' &&
        (await recordActivation(deps.store, deps.clock, credential, owner.replaces)) === 'activated'
      return { credentialId: credential.credentialId, state: activated ? 'active' : 'pending' }
    }
    const result = await verifyCredentialLogin(deps.connector, deps.store, credential)
    const age = deps.clock.nowMs() - Date.parse(credential.submittedAt)
    const final =
      result.status === 'pending' && age > (deps.maxPendingMs ?? 86_400_000)
        ? ({ status: 'failed', failureCode: 'unreachable' } as const)
        : result
    if (final.status === 'pending') {
      return { credentialId: credential.credentialId, state: 'pending' }
    }
    const changed = await recordVerification(deps.store, deps.clock, credential, final)
    return { credentialId: credential.credentialId, state: changed ? final.status : 'pending' }
  }
}

/**
 * Activates a pending credential in place of exactly the active credential
 * a plan approved (`replaces`, null for none), with its audit event, in one
 * transaction (Wave 5 correction F5): `replaced_other` when another
 * credential is active now (nothing changes; a different credential is never
 * replaced unnoticed), `busy` while another worker holds the row,
 * `not_pending` when it was decided already.
 */
export async function recordActivation(
  store: ControlStore,
  clock: Clock,
  credential: CredentialRecord,
  replaces: string | null,
): Promise<'activated' | 'busy' | 'not_pending' | 'replaced_other'> {
  return store.transaction('registry.credentials.activate_replacing', async (tx) => {
    const state = await tx.query(
      'registry.credentials.state',
      'SELECT state FROM registry.credentials WHERE credential_id = $1',
      [credential.credentialId],
    )
    if (state.rows[0]?.text('state') !== 'pending') return 'not_pending'
    const locked = await tx.query(
      'registry.credentials.lock',
      `SELECT 1 FROM registry.credentials WHERE credential_id = $1 AND state = 'pending' FOR UPDATE SKIP LOCKED`,
      [credential.credentialId],
    )
    if (locked.rows.length === 0) return 'busy'
    const active = await tx.query(
      'registry.credentials.active_lock',
      `SELECT credential_id FROM registry.credentials
        WHERE cluster_id = $1 AND access_role = $2 AND state = 'active' FOR UPDATE`,
      [credential.clusterId, credential.accessRole],
    )
    if ((active.rows[0]?.text('credential_id') ?? null) !== replaces) return 'replaced_other'
    await decide(tx, clock, credential, { status: 'active' })
    return 'activated'
  })
}

/**
 * Records the outcome of a login with a pending credential: activation (the
 * active one it replaces retired) or failure, with its audit event, in one
 * transaction. False when the credential is no longer pending or another
 * worker holds it.
 */
export async function recordVerification(
  store: ControlStore,
  clock: Clock,
  credential: CredentialRecord,
  final:
    | { readonly status: 'active' }
    | { readonly status: 'failed'; readonly failureCode: string },
): Promise<boolean> {
  const deps = { clock }
  return store.transaction('registry.credentials.verify', async (tx) => {
    const locked = await tx.query(
      'registry.credentials.lock',
      `SELECT 1 FROM registry.credentials WHERE credential_id = $1 AND state = 'pending' FOR UPDATE SKIP LOCKED`,
      [credential.credentialId],
    )
    if (locked.rows.length === 0) return false
    await decide(tx, deps.clock, credential, final)
    return true
  })
}

async function decide(
  tx: Tx,
  clock: Clock,
  credential: CredentialRecord,
  final:
    | { readonly status: 'active' }
    | { readonly status: 'failed'; readonly failureCode: string },
): Promise<void> {
  const deps = { clock }
  if (final.status === 'active') {
    await tx.query(
      'registry.credentials.retire_previous',
      `UPDATE registry.credentials SET state = 'retired'
          WHERE cluster_id = $1 AND access_role = $2 AND state = 'active'`,
      [credential.clusterId, credential.accessRole],
    )
    await tx.query(
      'registry.credentials.activate',
      `UPDATE registry.credentials SET state = 'active' WHERE credential_id = $1 AND state = 'pending'`,
      [credential.credentialId],
    )
  } else {
    await tx.query(
      'registry.credentials.fail',
      `UPDATE registry.credentials SET state = 'failed', failure_code = $2
          WHERE credential_id = $1 AND state = 'pending'`,
      [credential.credentialId, final.failureCode],
    )
  }
  await appendAuditEvent(
    tx,
    {
      action:
        final.status === 'active' ? 'registry.credential.verified' : 'registry.credential.failed',
      phase: 'completed',
      actor: { kind: 'system', identityId: null, label: 'system:worker' },
      subject: { clusterId: credential.clusterId as never },
      changes: {
        credentialId: credential.credentialId,
        role: credential.accessRole,
        version: credential.secretVersion,
        ...(final.status === 'failed' ? { failureCode: final.failureCode } : {}),
      },
      result:
        final.status === 'active'
          ? { status: 'succeeded', verificationOutcome: 'passed' }
          : { status: 'failed', verificationOutcome: 'failed', errorCode: final.failureCode },
    },
    { clock: deps.clock },
  )
}
