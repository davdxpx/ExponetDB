import { LEDGER_TABLES } from './ledger.ts'
import { type CatalogReader, LEDGER_OWNER_ROLE, type TargetSession } from './session.ts'
import { ident, join, sql } from './sql.ts'

/**
 * The ledger guard (OD-55 (d), [planning-and-apply.md §4.3](../../../exponetdb-docs/04-migrations/planning-and-apply.md#43-transactional-migration),
 * threat T38): what a migration's authored statements may never change in
 * the `exponetdb` schema of the target, compared inside the migration's
 * own transaction before the first statement and after each one, instead
 * of trusting the role a statement ran as. Procedural code (a `DO` block, a
 * routine) can switch to any role the migrator holds and back; whatever it
 * did to the ledger or the identity marker shows here, and the executor
 * rolls the transaction back.
 *
 * The state is, per ledger table, the row count and a SHA-256 over every
 * row (`xmin` and the row's text, in primary-key order), and one SHA-256
 * over the schema's catalog shape: the namespace, its relations (owner,
 * ACL, file node, row security, rules, triggers), their columns, defaults,
 * constraints, indexes, triggers (and whether they are enabled), rules,
 * policies, inheritance, and the routines of the schema and of the
 * relations' triggers (owner, ACL, security, settings, a digest of the
 * body). `xmin` changes with every new row version, so an update that
 * writes the same values, a delete and re-insert, a `TRUNCATE` (a new file
 * node) or a trigger disabled and enabled again all differ.
 *
 * No other writer: {@link lockLedgerForGuard} takes `SHARE` on every
 * ledger table for the rest of the transaction (as the ledger owner, the
 * only role that may), so a concurrent `migration.verify` that records a
 * verification run waits until the migration commits instead of changing
 * the state between two reads. Catalog rows of the schema change only by
 * DDL, which needs locks the migration's transaction holds or conflicts
 * with. Every name is schema-qualified and every operator is
 * `OPERATOR(pg_catalog.…)`, so nothing a migration creates on its
 * `search_path` is called by this query.
 */
export interface LedgerGuardState {
  /** Per ledger table `<rows>:<sha256 hex>`, and `shape`: the catalog digest. */
  readonly parts: Readonly<Record<string, string>>
}

/** The ledger tables in `SHARE` mode until the transaction ends, taken as the ledger owner. */
export async function lockLedgerForGuard(session: TargetSession): Promise<void> {
  await session.query(sql`SET LOCAL ROLE ${ident(LEDGER_OWNER_ROLE)}`)
  await session.query(
    sql`LOCK TABLE exponetdb.target_identity, exponetdb.ledger_meta, exponetdb.schema_migrations,
                   exponetdb.migration_verifications, exponetdb.migration_events IN SHARE MODE`,
  )
  await session.query(sql`RESET ROLE`)
}

const ORDER: Readonly<Record<(typeof LEDGER_TABLES)[number], string>> = {
  target_identity: 'singleton',
  ledger_meta: 'singleton',
  schema_migrations: 'migration_id',
  migration_verifications: 'verification_id',
  migration_events: 'event_seq',
}

/** `<rows>:<sha256 hex>` of one ledger table: every row's `xmin` and text, in key order. */
function rowsOf(table: (typeof LEDGER_TABLES)[number]) {
  return sql`(SELECT pg_catalog.concat_ws(':', pg_catalog.count(*), pg_catalog.encode(pg_catalog.sha256(
      pg_catalog.convert_to(pg_catalog.string_agg(pg_catalog.concat_ws(' ', t.xmin, t::text), pg_catalog.chr(10)
        ORDER BY t.${ident(ORDER[table])}), 'UTF8')), 'hex'))
     FROM exponetdb.${ident(table)} t) AS ${ident(table)}`
}

const GUARD = sql`WITH ns AS (
  SELECT n.oid, pg_catalog.concat_ws(' ', n.oid, n.xmin, n.nspowner, n.nspacl) AS line
    FROM pg_catalog.pg_namespace n WHERE n.nspname OPERATOR(pg_catalog.=) 'exponetdb'
), rels AS (
  SELECT c.oid, pg_catalog.concat_ws(' ', c.oid, c.xmin, c.relname, c.relkind, c.relowner, c.relacl,
         c.relfilenode, c.relrowsecurity, c.relforcerowsecurity, c.relhasrules, c.relhastriggers,
         c.relpersistence, c.relispartition, c.reloptions) AS line
    FROM pg_catalog.pg_class c WHERE c.relnamespace OPERATOR(pg_catalog.=) ANY (ARRAY(SELECT oid FROM ns))
), triggers AS (
  SELECT g.tgfoid, pg_catalog.concat_ws(' ', g.oid, g.xmin, g.tgrelid, g.tgname, g.tgfoid, g.tgenabled) AS line
    FROM pg_catalog.pg_trigger g WHERE g.tgrelid OPERATOR(pg_catalog.=) ANY (ARRAY(SELECT oid FROM rels))
), shape AS (
  SELECT pg_catalog.concat_ws(pg_catalog.chr(10),
    (SELECT pg_catalog.string_agg(line, pg_catalog.chr(10) ORDER BY oid) FROM ns),
    (SELECT pg_catalog.string_agg(line, pg_catalog.chr(10) ORDER BY oid) FROM rels),
    (SELECT pg_catalog.string_agg(pg_catalog.concat_ws(' ', a.attrelid, a.attnum, a.xmin, a.attname, a.atttypid,
            a.attnotnull, a.attisdropped, a.atthasdef, a.attgenerated, a.attacl), pg_catalog.chr(10)
            ORDER BY a.attrelid, a.attnum)
       FROM pg_catalog.pg_attribute a
      WHERE a.attrelid OPERATOR(pg_catalog.=) ANY (ARRAY(SELECT oid FROM rels)) AND a.attnum OPERATOR(pg_catalog.>) 0),
    (SELECT pg_catalog.string_agg(pg_catalog.concat_ws(' ', d.oid, d.xmin, d.adrelid, d.adnum), pg_catalog.chr(10) ORDER BY d.oid)
       FROM pg_catalog.pg_attrdef d WHERE d.adrelid OPERATOR(pg_catalog.=) ANY (ARRAY(SELECT oid FROM rels))),
    (SELECT pg_catalog.string_agg(pg_catalog.concat_ws(' ', k.oid, k.xmin, k.conname, k.contype, k.conrelid), pg_catalog.chr(10) ORDER BY k.oid)
       FROM pg_catalog.pg_constraint k
      WHERE k.conrelid OPERATOR(pg_catalog.=) ANY (ARRAY(SELECT oid FROM rels))
         OR k.confrelid OPERATOR(pg_catalog.=) ANY (ARRAY(SELECT oid FROM rels))
         OR k.connamespace OPERATOR(pg_catalog.=) ANY (ARRAY(SELECT oid FROM ns))),
    (SELECT pg_catalog.string_agg(pg_catalog.concat_ws(' ', i.indexrelid, i.xmin, i.indrelid), pg_catalog.chr(10) ORDER BY i.indexrelid)
       FROM pg_catalog.pg_index i WHERE i.indrelid OPERATOR(pg_catalog.=) ANY (ARRAY(SELECT oid FROM rels))),
    (SELECT pg_catalog.string_agg(line, pg_catalog.chr(10) ORDER BY line) FROM triggers),
    (SELECT pg_catalog.string_agg(pg_catalog.concat_ws(' ', r.oid, r.xmin, r.ev_class, r.rulename, r.ev_enabled), pg_catalog.chr(10) ORDER BY r.oid)
       FROM pg_catalog.pg_rewrite r WHERE r.ev_class OPERATOR(pg_catalog.=) ANY (ARRAY(SELECT oid FROM rels))),
    (SELECT pg_catalog.string_agg(pg_catalog.concat_ws(' ', p.oid, p.xmin, p.polrelid, p.polname), pg_catalog.chr(10) ORDER BY p.oid)
       FROM pg_catalog.pg_policy p WHERE p.polrelid OPERATOR(pg_catalog.=) ANY (ARRAY(SELECT oid FROM rels))),
    (SELECT pg_catalog.string_agg(pg_catalog.concat_ws(' ', h.inhrelid, h.inhparent, h.xmin), pg_catalog.chr(10) ORDER BY h.inhrelid, h.inhparent)
       FROM pg_catalog.pg_inherits h
      WHERE h.inhrelid OPERATOR(pg_catalog.=) ANY (ARRAY(SELECT oid FROM rels))
         OR h.inhparent OPERATOR(pg_catalog.=) ANY (ARRAY(SELECT oid FROM rels))),
    (SELECT pg_catalog.string_agg(pg_catalog.concat_ws(' ', f.oid, f.xmin, f.proname, f.proowner, f.proacl, f.prosecdef,
            f.proconfig, pg_catalog.md5(f.prosrc)), pg_catalog.chr(10) ORDER BY f.oid)
       FROM pg_catalog.pg_proc f
      WHERE f.pronamespace OPERATOR(pg_catalog.=) ANY (ARRAY(SELECT oid FROM ns))
         OR f.oid OPERATOR(pg_catalog.=) ANY (ARRAY(SELECT tgfoid FROM triggers)))
  ) AS text
)
SELECT ${join(LEDGER_TABLES.map(rowsOf), sql`, `)},
       (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(text, 'UTF8')), 'hex') FROM shape) AS shape`

/** The guard could not be read (a privilege, a missing table): the caller fails closed. */
export class LedgerGuardUnreadable extends Error {
  override readonly name = 'LedgerGuardUnreadable'
  constructor() {
    super('The ledger guard could not be read.')
  }
}

/**
 * The guarded state as the current transaction sees it, read by the
 * migrator (the ledger is readable by it; an execution role cannot read
 * the schema). A read that fails, or a schema without the ledger, throws:
 * the caller fails closed.
 */
export async function readLedgerGuard(reader: CatalogReader): Promise<LedgerGuardState> {
  const row = (await reader.query(GUARD))[0]
  if (row === undefined) throw new LedgerGuardUnreadable()
  const parts: Record<string, string> = {}
  for (const name of [...LEDGER_TABLES, 'shape'] as const) {
    const value = row.textOrNull(name)
    if (value === null) throw new LedgerGuardUnreadable()
    parts[name] = value
  }
  return { parts }
}

/** The guarded parts that differ (table names, or `shape`), in a fixed order. */
export function changedLedgerParts(before: LedgerGuardState, after: LedgerGuardState): string[] {
  return [...LEDGER_TABLES, 'shape'].filter((k) => before.parts[k] !== after.parts[k])
}
