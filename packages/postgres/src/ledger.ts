import { sha256 } from '@exponetdb/kernel/hash'
import { TargetError } from './errors.ts'
import type { TargetRow } from './rows.ts'
import { type CatalogReader, LEDGER_OWNER_ROLE, ROLE_NAMES, type TargetSession } from './session.ts'
import { ident, sql, type TrustedSql } from './sql.ts'

/**
 * The target side of registration ([ledger.md §2, §4](../../../exponetdb-docs/04-migrations/ledger.md#2-schema-exponetdb-in-each-target-database),
 * [concurrency.md §2](../../../exponetdb-docs/04-migrations/concurrency.md#2-lock-scope-and-key-derivation),
 * C-27): the identity marker and the empty ledger in schema `exponetdb`,
 * owned by the `NOLOGIN` ledger owner, written by the migrator, read by the
 * observer and the reader. Everything here runs on a migrator session under
 * the target's schema lock, in one transaction.
 */
export const LEDGER_SCHEMA = 'exponetdb'
export const LEDGER_SCHEMA_VERSION = 1

/** `key1` of every ExponetDB advisory lock: ASCII `EXDB`. */
export const LOCK_NAMESPACE = 1163412546

/** `key2 = int4(first 4 bytes, big-endian, of SHA-256("exponetdb/lock/v1/<class>/<targetId>"))`. */
export function lockKey2(lockClass: 'schema' | 'maintenance', targetId: string): number {
  const digest = sha256(`exponetdb/lock/v1/${lockClass}/${targetId}`)
  return new DataView(digest.buffer, digest.byteOffset, 4).getInt32(0, false)
}

export interface IdentityMarker {
  readonly installationId: string
  readonly targetId: string
  readonly targetPath: string
  readonly tier: 'prod' | 'nonprod'
  readonly generation: number
  readonly stampedAt: string
  readonly stampedByOperation: string
  readonly clusterSystemId: string
}

/**
 * Signs of an ExponetDB Control Store in a database, read from the catalogs
 * (any role can read them; no table privilege is needed). The Control Store
 * is never a managed target (C-34): any one sign refuses registration, so a
 * restored or renamed copy of a Control Store is refused as well.
 */
const CONTROL_STORE_SIGNS = sql`SELECT n.nspname || '.' || c.relname AS sign
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE (n.nspname, c.relname) IN (('control', 'installation'), ('control', 'schema_migrations'),
                                  ('secrets', 'master_keys'), ('audit', 'audit_events'),
                                  ('operations', 'plans'), ('auth', 'role_bindings'))
 ORDER BY 1`

export async function controlStoreSigns(session: TargetSession): Promise<string[]> {
  const rows = await session.query(CONTROL_STORE_SIGNS)
  return rows.map((r) => r.text('sign'))
}

// From the catalogs, not `to_regclass`: a name lookup needs USAGE on the schema, existence does not.
const MARKER_PRESENT = sql`SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                       WHERE n.nspname = 'exponetdb' AND c.relname = 'target_identity' AND c.relkind = 'r') AS present`

const MARKER_READ = sql`SELECT installation_id, target_id, target_path, tier, generation::text AS generation,
       stamped_at::text AS stamped_at, stamped_by_op, cluster_system_id
  FROM exponetdb.target_identity`

function markerFrom(row: TargetRow): IdentityMarker {
  const tier = row.text('tier')
  if (tier !== 'prod' && tier !== 'nonprod') {
    throw new TargetError('TARGET_IDENTITY_MISMATCH', 'marker_mismatch')
  }
  return {
    installationId: row.text('installation_id'),
    targetId: row.text('target_id'),
    targetPath: row.text('target_path'),
    tier,
    generation: row.int('generation'),
    stampedAt: row.text('stamped_at'),
    stampedByOperation: row.text('stamped_by_op'),
    clusterSystemId: row.text('cluster_system_id'),
  }
}

export type MarkerState =
  | { readonly status: 'absent' }
  | { readonly status: 'present'; readonly marker: IdentityMarker }
  /** The table exists but has no row, more than one, or this role cannot read it. */
  | { readonly status: 'unreadable'; readonly reason: 'empty' | 'privilege' | 'shape' }

/**
 * The identity marker as an open transaction sees it (planning reads it in
 * the same read-only snapshot as the ledger and the fingerprint).
 */
export async function markerWithin(reader: CatalogReader): Promise<MarkerState> {
  const present = await reader.query(MARKER_PRESENT)
  if (present[0]?.bool('present') !== true) {
    return { status: 'absent' }
  }
  const rows = await reader.query(MARKER_READ).catch((error: unknown) => {
    if (error instanceof TargetError && error.code === 'PERMISSION_DENIED') return null
    throw error
  })
  if (rows === null) return { status: 'unreadable', reason: 'privilege' }
  const row = rows[0]
  if (rows.length !== 1 || row === undefined) {
    return { status: 'unreadable', reason: 'empty' }
  }
  try {
    return { status: 'present', marker: markerFrom(row) }
  } catch {
    return { status: 'unreadable', reason: 'shape' }
  }
}

/** Reads the identity marker (observer, reader or migrator). */
export async function readMarker(session: TargetSession): Promise<MarkerState> {
  const present = await session.query(MARKER_PRESENT)
  if (present[0]?.bool('present') !== true) {
    return { status: 'absent' }
  }
  let rows: TargetRow[]
  try {
    rows = await session.query(MARKER_READ)
  } catch (error) {
    if (error instanceof TargetError && error.code === 'PERMISSION_DENIED') {
      return { status: 'unreadable', reason: 'privilege' }
    }
    throw error
  }
  const row = rows[0]
  if (rows.length !== 1 || row === undefined) {
    return { status: 'unreadable', reason: 'empty' }
  }
  try {
    return { status: 'present', marker: markerFrom(row) }
  } catch {
    return { status: 'unreadable', reason: 'shape' }
  }
}

const OBSERVER = ROLE_NAMES.observer
const READER = ROLE_NAMES.reader
const VERIFIER = ROLE_NAMES.verifier
const OPERATOR = ROLE_NAMES.operator
const MIGRATOR = ROLE_NAMES.migrator

/** The ledger tables, in creation order. */
export const LEDGER_TABLES = [
  'target_identity',
  'ledger_meta',
  'schema_migrations',
  'migration_verifications',
  'migration_events',
] as const

/**
 * Ledger DDL, version 1, run as the ledger owner (`SET LOCAL ROLE`). Role
 * names are fixed constants; nothing from a request or a catalog is spliced.
 */
function ledgerDdl(): TrustedSql[] {
  return [
    sql`CREATE SCHEMA exponetdb`,
    sql`REVOKE ALL ON SCHEMA exponetdb FROM PUBLIC`,
    sql`CREATE TABLE exponetdb.target_identity (
  singleton           boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  installation_id     text    NOT NULL,
  target_id           text    NOT NULL,
  target_path         text    NOT NULL,
  tier                text    NOT NULL CHECK (tier IN ('prod','nonprod')),
  generation          integer NOT NULL CHECK (generation > 0),
  stamped_at          timestamptz NOT NULL,
  stamped_by_op       text    NOT NULL,
  cluster_system_id   text    NOT NULL
)`,
    sql`CREATE TABLE exponetdb.ledger_meta (
  singleton             boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  ledger_schema_version integer NOT NULL,
  project_id            text    NOT NULL,
  baseline_id           text,
  created_at            timestamptz NOT NULL
)`,
    sql`CREATE TABLE exponetdb.schema_migrations (
  migration_id          text PRIMARY KEY,
  origin                text NOT NULL CHECK (origin IN ('exponetdb','legacy_import','baseline')),
  name                  text NOT NULL,
  checksum              text NOT NULL,
  checksum_provenance   text NOT NULL CHECK (checksum_provenance IN
                          ('computed_at_apply','legacy_file_at_import','legacy_tool_hash',
                           'legacy_applied_statements','unknown')),
  source_digest         text,
  verify_digest         text,
  rollback_digest       text,
  manifest              jsonb,
  dependencies          text[] NOT NULL DEFAULT '{}',
  transactional         boolean,
  source                jsonb,
  applied_seq           bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  applied_at            timestamptz NOT NULL,
  apply_duration_ms     integer,
  plan_id               text,
  operation_id          text NOT NULL,
  actor_ref             text,
  client_ref            text,
  engine_version        text NOT NULL,
  pg_version_num        integer NOT NULL,
  fingerprint_before    text,
  fingerprint_after     text,
  reverted_at           timestamptz,
  reverted_by_op        text
)`,
    sql`CREATE TABLE exponetdb.migration_verifications (
  verification_id   text PRIMARY KEY,
  migration_id      text NOT NULL REFERENCES exponetdb.schema_migrations,
  operation_id      text NOT NULL,
  verify_digest     text,
  started_at        timestamptz NOT NULL,
  finished_at       timestamptz NOT NULL,
  status            text NOT NULL CHECK (status IN ('passed','failed','partial','error')),
  structural        jsonb NOT NULL,
  runtime           jsonb,
  engine            jsonb NOT NULL,
  fingerprint       text NOT NULL
)`,
    sql`CREATE TABLE exponetdb.migration_events (
  event_seq     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  migration_id  text NOT NULL,
  operation_id  text NOT NULL,
  event         text NOT NULL CHECK (event IN (
                  'nontx_started','nontx_statement_done','nontx_failed',
                  'applied','reverted','imported','baselined','ledger_reconciled')),
  detail        jsonb NOT NULL DEFAULT '{}'
)`,
    sql`CREATE FUNCTION exponetdb.refuse_change() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  RAISE EXCEPTION 'exponetdb ledger rows are append-only' USING ERRCODE = 'EXL01';
END
$fn$`,
    sql`CREATE FUNCTION exponetdb.guard_migration_update() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  IF OLD.reverted_at IS NOT NULL OR OLD.reverted_by_op IS NOT NULL
     OR (to_jsonb(NEW) - 'reverted_at' - 'reverted_by_op') IS DISTINCT FROM (to_jsonb(OLD) - 'reverted_at' - 'reverted_by_op') THEN
    RAISE EXCEPTION 'only reverted_at and reverted_by_op may be set, once' USING ERRCODE = 'EXL02';
  END IF;
  RETURN NEW;
END
$fn$`,
    sql`CREATE FUNCTION exponetdb.guard_identity_update() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  IF NEW.installation_id IS DISTINCT FROM OLD.installation_id OR NEW.target_id IS DISTINCT FROM OLD.target_id
     OR NEW.generation < OLD.generation THEN
    RAISE EXCEPTION 'the identity marker keeps its installation and target; generations only grow' USING ERRCODE = 'EXL03';
  END IF;
  RETURN NEW;
END
$fn$`,
    sql`CREATE TRIGGER schema_migrations_update BEFORE UPDATE ON exponetdb.schema_migrations
  FOR EACH ROW EXECUTE FUNCTION exponetdb.guard_migration_update()`,
    sql`CREATE TRIGGER schema_migrations_delete BEFORE DELETE ON exponetdb.schema_migrations
  FOR EACH ROW EXECUTE FUNCTION exponetdb.refuse_change()`,
    sql`CREATE TRIGGER migration_verifications_change BEFORE UPDATE OR DELETE ON exponetdb.migration_verifications
  FOR EACH ROW EXECUTE FUNCTION exponetdb.refuse_change()`,
    sql`CREATE TRIGGER migration_events_change BEFORE UPDATE OR DELETE ON exponetdb.migration_events
  FOR EACH ROW EXECUTE FUNCTION exponetdb.refuse_change()`,
    sql`CREATE TRIGGER target_identity_update BEFORE UPDATE ON exponetdb.target_identity
  FOR EACH ROW EXECUTE FUNCTION exponetdb.guard_identity_update()`,
    sql`CREATE TRIGGER target_identity_delete BEFORE DELETE ON exponetdb.target_identity
  FOR EACH ROW EXECUTE FUNCTION exponetdb.refuse_change()`,
    sql`CREATE TRIGGER ledger_meta_delete BEFORE DELETE ON exponetdb.ledger_meta
  FOR EACH ROW EXECUTE FUNCTION exponetdb.refuse_change()`,
    // An event trigger of the database may have enabled row security on the new tables
    // (a real pattern); the ledger is read by roles without BYPASSRLS, so it is off.
    sql`ALTER TABLE exponetdb.target_identity DISABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY`,
    sql`ALTER TABLE exponetdb.ledger_meta DISABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY`,
    sql`ALTER TABLE exponetdb.schema_migrations DISABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY`,
    sql`ALTER TABLE exponetdb.migration_verifications DISABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY`,
    sql`ALTER TABLE exponetdb.migration_events DISABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY`,
    // Whatever default privileges said: nothing for PUBLIC, then exactly the documented grants.
    sql`REVOKE ALL ON ALL TABLES IN SCHEMA exponetdb FROM PUBLIC`,
    sql`REVOKE ALL ON ALL SEQUENCES IN SCHEMA exponetdb FROM PUBLIC`,
    sql`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA exponetdb FROM PUBLIC`,
    // The operator reads the marker too: its sessions can signal backends, so C-27 holds for it.
    sql`GRANT USAGE ON SCHEMA exponetdb TO ${ident(OBSERVER)}, ${ident(READER)}, ${ident(VERIFIER)}, ${ident(OPERATOR)}, ${ident(MIGRATOR)}`,
    sql`GRANT SELECT ON ALL TABLES IN SCHEMA exponetdb TO ${ident(OBSERVER)}, ${ident(READER)}, ${ident(VERIFIER)}, ${ident(OPERATOR)}, ${ident(MIGRATOR)}`,
    sql`GRANT INSERT ON ALL TABLES IN SCHEMA exponetdb TO ${ident(MIGRATOR)}`,
    sql`GRANT UPDATE ON exponetdb.target_identity, exponetdb.ledger_meta TO ${ident(MIGRATOR)}`,
    sql`GRANT UPDATE (reverted_at, reverted_by_op) ON exponetdb.schema_migrations TO ${ident(MIGRATOR)}`,
    sql`GRANT USAGE ON ALL SEQUENCES IN SCHEMA exponetdb TO ${ident(MIGRATOR)}`,
  ]
}

export interface Stamp {
  readonly installationId: string
  readonly targetId: string
  readonly targetPath: string
  readonly tier: 'prod' | 'nonprod'
  readonly generation: number
  readonly operationId: string
  readonly projectId: string
  /** The oid the plan observed: a database dropped and re-created under the same name is refused. */
  readonly databaseOid: string
}

export type StampResult =
  /** Schema, ledger and marker were created in this transaction. */
  | { readonly status: 'stamped'; readonly marker: IdentityMarker }
  /** The marker already names exactly this target and generation (a retry after a crash). */
  | { readonly status: 'already_stamped'; readonly marker: IdentityMarker }

export type StampRefusal =
  | 'control_store'
  | 'foreign_installation'
  | 'other_target'
  | 'generation_mismatch'
  | 'marker_unreadable'
  | 'schema_exists_without_marker'
  | 'database_mismatch'
  | 'lock_unavailable'

export class StampRefused extends Error {
  override readonly name = 'StampRefused'
  readonly reason: StampRefusal
  readonly details: Readonly<Record<string, string | number>>
  constructor(reason: StampRefusal, details: Readonly<Record<string, string | number>> = {}) {
    super(`Registration was refused by the target (${reason}).`)
    this.reason = reason
    this.details = details
  }
}

const TRY_LOCK = sql`SELECT pg_catalog.pg_try_advisory_lock($1::int, $2::int) AS locked`
const TRY_LOCK_SHARED = sql`SELECT pg_catalog.pg_try_advisory_lock_shared($1::int, $2::int) AS locked`
const UNLOCK = sql`SELECT pg_catalog.pg_advisory_unlock($1::int, $2::int) AS unlocked`
const UNLOCK_SHARED = sql`SELECT pg_catalog.pg_advisory_unlock_shared($1::int, $2::int) AS unlocked`
const LOCK_HOLDERS = sql`SELECT DISTINCT a.pid, coalesce(a.application_name, '') AS application_name
  FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_stat_activity a ON a.pid = l.pid
 WHERE l.locktype = 'advisory' AND l.classid = $1::int::oid AND l.objsubid = 2 AND l.granted
   AND l.objid IN ($2::int::oid, $3::int::oid) AND l.pid <> pg_catalog.pg_backend_pid()
   AND l.database = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())
 ORDER BY a.pid LIMIT 4`

/** The target's lock is held by another session past the deadline. */
export class LockUnavailable extends Error {
  override readonly name = 'LockUnavailable'
  /** The holders' `application_name` (`exponetdb/op_…` for ExponetDB's own sessions). */
  readonly holders: readonly string[]
  constructor(holders: readonly string[]) {
    super('The target lock is held by another session.')
    this.holders = holders
  }
}

export interface TargetLockOptions {
  /** How long to try (default 30 s; concurrency.md §3 allows up to 10 minutes). */
  readonly deadlineMs?: number
  /** Called while waiting, with the holders seen (the operation shows them as `waitingFor`). */
  readonly onWait?: (holders: readonly string[]) => void
  readonly signal?: AbortSignal
}

/**
 * Takes a target lock of `lockClass` on this session (concurrency.md §2,
 * §3): session-level advisory locks under key1 `EXDB`, tried in a loop
 * with backoff until a deadline, never a blocking wait.
 *
 * Two keys do not exclude each other by themselves, so the classes are
 * built from both keys, always in the same order (maintenance, then
 * schema), which also rules out a deadlock between two takers:
 *
 * - `schema`: the maintenance key **shared**, then the schema key
 *   exclusive: two schema holders exclude each other on the schema key;
 * - `maintenance`: the maintenance key **exclusive**: it waits for every
 *   schema holder (each holds the maintenance key shared) and every schema
 *   taker waits for it.
 *
 * Returns the release (both keys, in reverse order). A timeout throws
 * {@link LockUnavailable}; nothing is held then.
 */
export async function takeTargetLock(
  session: TargetSession,
  targetId: string,
  lockClass: 'schema' | 'maintenance',
  options: TargetLockOptions = {},
): Promise<() => Promise<void>> {
  const maintenance = lockKey2('maintenance', targetId)
  const schema = lockKey2('schema', targetId)
  const until = Date.now() + (options.deadlineMs ?? 30_000)
  let wait = 250
  for (;;) {
    options.signal?.throwIfAborted()
    const first = await session.query(lockClass === 'schema' ? TRY_LOCK_SHARED : TRY_LOCK, [
      LOCK_NAMESPACE,
      maintenance,
    ])
    if (first[0]?.bool('locked') === true) {
      if (lockClass === 'maintenance') {
        return async () => {
          if (session.usable) {
            await session.query(UNLOCK, [LOCK_NAMESPACE, maintenance]).catch(() => undefined)
          }
        }
      }
      const second = await session.query(TRY_LOCK, [LOCK_NAMESPACE, schema])
      if (second[0]?.bool('locked') === true) {
        return async () => {
          if (session.usable) {
            await session.query(UNLOCK, [LOCK_NAMESPACE, schema]).catch(() => undefined)
            await session.query(UNLOCK_SHARED, [LOCK_NAMESPACE, maintenance]).catch(() => undefined)
          }
        }
      }
      await session.query(UNLOCK_SHARED, [LOCK_NAMESPACE, maintenance])
    }
    const holders = (await session.query(LOCK_HOLDERS, [LOCK_NAMESPACE, maintenance, schema])).map(
      (r) => r.text('application_name').slice(0, 63),
    )
    if (Date.now() + wait > until) {
      throw new LockUnavailable(holders)
    }
    options.onWait?.(holders)
    // Jitter, so two waiting workers do not retry in step.
    await new Promise((resolve) => setTimeout(resolve, wait + Math.floor(Math.random() * 100)))
    wait = Math.min(wait * 2, 5000)
  }
}

const SCHEMA_EXISTS = sql`SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'exponetdb') AS present`
const SET_OWNER = sql`SET LOCAL ROLE ${ident(LEDGER_OWNER_ROLE)}`
const RESET = sql`RESET ROLE`
const INSERT_MARKER = sql`INSERT INTO exponetdb.target_identity
  (installation_id, target_id, target_path, tier, generation, stamped_at, stamped_by_op, cluster_system_id)
VALUES ($1, $2, $3, $4, $5::int, clock_timestamp(), $6, $7)`
const INSERT_META = sql`INSERT INTO exponetdb.ledger_meta (ledger_schema_version, project_id, baseline_id, created_at)
VALUES ($1::int, $2, NULL, clock_timestamp())`

/**
 * Takes the target's schema lock on this (migrator) session for
 * registration ({@link takeTargetLock} of class `schema`). Returns the release.
 */
export async function takeSchemaLock(
  session: TargetSession,
  targetId: string,
  deadlineMs = 30_000,
): Promise<() => Promise<void>> {
  try {
    return await takeTargetLock(session, targetId, 'schema', { deadlineMs })
  } catch (error) {
    if (error instanceof LockUnavailable) {
      throw new StampRefused('lock_unavailable')
    }
    throw error
  }
}

/**
 * Every refusal of a stamp, before anything is written (registration runs
 * it before it records the target in the Control Store, and the stamp runs
 * it again under the same schema lock):
 *
 * 1. a Control Store (any sign) is refused;
 * 2. another cluster (`system_identifier`) or another database than the one
 *    the plan observed (oid) is refused;
 * 3. an existing marker of another installation, another target, or this
 *    target at another generation is refused; the same marker is a retry;
 * 4. an `exponetdb` schema without a marker is refused (someone else's
 *    object, or a half-made one: a human decides).
 */
export async function preflightStamp(
  session: TargetSession,
  stamp: Stamp,
  expectedSystemId: string,
): Promise<
  | { readonly status: 'fresh' }
  | { readonly status: 'already_stamped'; readonly marker: IdentityMarker }
> {
  const signs = await controlStoreSigns(session)
  if (signs.length > 0) {
    throw new StampRefused('control_store', { sign: signs[0] ?? '' })
  }
  if (session.facts.systemIdentifier !== expectedSystemId) {
    throw new TargetError('CLUSTER_IDENTITY_MISMATCH', 'system_identifier')
  }
  if (session.facts.databaseOid !== stamp.databaseOid) {
    throw new StampRefused('database_mismatch', { field: 'oid' })
  }
  const existing = await readMarker(session)
  if (existing.status === 'present') {
    const m = existing.marker
    if (m.installationId !== stamp.installationId) {
      throw new StampRefused('foreign_installation')
    }
    if (m.targetId !== stamp.targetId) {
      throw new StampRefused('other_target')
    }
    if (m.generation !== stamp.generation) {
      throw new StampRefused('generation_mismatch', {
        expected: stamp.generation,
        actual: m.generation,
      })
    }
    return { status: 'already_stamped', marker: m }
  }
  if (existing.status === 'unreadable') {
    throw new StampRefused('marker_unreadable', { reason: existing.reason })
  }
  const schema = await session.query(SCHEMA_EXISTS)
  if (schema[0]?.bool('present') === true) {
    throw new StampRefused('schema_exists_without_marker')
  }
  return { status: 'fresh' }
}

/**
 * Stamps the identity marker and creates the empty ledger, idempotently,
 * in one transaction of a migrator session that holds the schema lock:
 * after `preflightStamp` passes, the schema and tables are created as the
 * ledger owner and the marker and ledger metadata are inserted as the
 * migrator.
 */
export async function stampTarget(
  session: TargetSession,
  stamp: Stamp,
  expectedSystemId: string,
): Promise<StampResult> {
  const pre = await preflightStamp(session, stamp, expectedSystemId)
  if (pre.status === 'already_stamped') {
    return pre
  }
  await session.transaction(
    async () => {
      await session.query(SET_OWNER)
      for (const statement of ledgerDdl()) {
        await session.query(statement)
      }
      await session.query(RESET)
      await session.query(INSERT_MARKER, [
        stamp.installationId,
        stamp.targetId,
        stamp.targetPath,
        stamp.tier,
        stamp.generation,
        stamp.operationId,
        expectedSystemId,
      ])
      await session.query(INSERT_META, [LEDGER_SCHEMA_VERSION, stamp.projectId])
    },
    { statementTimeoutMs: 60_000, lockTimeoutMs: 5000 },
  )
  const after = await readMarker(session)
  if (after.status !== 'present') {
    throw new TargetError('TARGET_IDENTITY_MISMATCH', 'marker_missing')
  }
  return { status: 'stamped', marker: after.marker }
}

/** What a fresh session must find after a stamp (registration verification). */
export interface LedgerShape {
  readonly owner: string | null
  readonly tables: readonly string[]
  /** Tables with row security enabled or forced (must be none). */
  readonly rowSecurity: readonly string[]
  /** Grantees other than the documented ones on the schema or its tables (must be none). */
  readonly unexpectedGrantees: readonly string[]
  readonly ledgerSchemaVersion: number | null
  readonly rows: number
}

const LEDGER_SHAPE = sql`SELECT
  (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'exponetdb') AS owner,
  (SELECT pg_catalog.json_agg(c.relname ORDER BY c.relname COLLATE "C") FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'exponetdb' AND c.relkind = 'r') AS tables,
  (SELECT pg_catalog.json_agg(c.relname ORDER BY c.relname COLLATE "C") FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'exponetdb' AND c.relkind = 'r' AND (c.relrowsecurity OR c.relforcerowsecurity)) AS row_security,
  (SELECT pg_catalog.json_agg(DISTINCT g.grantee ORDER BY g.grantee) FROM (
     SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END AS grantee
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace,
            LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
      WHERE n.nspname = 'exponetdb'
     UNION ALL
     SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END
       FROM pg_catalog.pg_namespace n,
            LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
      WHERE n.nspname = 'exponetdb') g) AS grantees,
  (SELECT m.ledger_schema_version FROM exponetdb.ledger_meta m) AS ledger_schema_version,
  (SELECT (SELECT count(*) FROM exponetdb.schema_migrations) + (SELECT count(*) FROM exponetdb.migration_verifications)
        + (SELECT count(*) FROM exponetdb.migration_events)) AS rows`

const EXPECTED_GRANTEES: ReadonlySet<string> = new Set([
  LEDGER_OWNER_ROLE,
  OBSERVER,
  READER,
  VERIFIER,
  OPERATOR,
  MIGRATOR,
])

/** Reads the ledger's shape (any role with `USAGE` and `SELECT` on `exponetdb`). */
export async function ledgerShape(session: TargetSession): Promise<LedgerShape> {
  const row = (await session.query(LEDGER_SHAPE))[0]
  if (row === undefined) {
    throw new TargetError('TARGET_IDENTITY_MISMATCH', 'marker_missing')
  }
  const strings = (column: string) =>
    row.jsonArray(column).filter((v): v is string => typeof v === 'string')
  return {
    owner: row.textOrNull('owner'),
    tables: strings('tables'),
    rowSecurity: strings('row_security'),
    unexpectedGrantees: strings('grantees').filter((g) => !EXPECTED_GRANTEES.has(g)),
    ledgerSchemaVersion: row.intOrNull('ledger_schema_version'),
    rows: row.int('rows'),
  }
}

/** True when the shape is the documented empty ledger of version 1. */
export function isEmptyLedger(shape: LedgerShape): boolean {
  return (
    shape.owner === LEDGER_OWNER_ROLE &&
    shape.tables.length === LEDGER_TABLES.length &&
    [...LEDGER_TABLES].sort().every((t, i) => shape.tables[i] === t) &&
    shape.rowSecurity.length === 0 &&
    shape.unexpectedGrantees.length === 0 &&
    shape.ledgerSchemaVersion === LEDGER_SCHEMA_VERSION &&
    shape.rows === 0
  )
}
