import type { AccessRole } from '@exponetdb/contracts'
import { sql, TargetError } from '@exponetdb/postgres'
import type { Connector } from './connect.ts'
import { conflict } from './errors.ts'

/**
 * What a database is, read live through a guarded session (constant
 * engine statements only): its oid (identity within the cluster; a
 * database dropped and created again under the same name has another
 * one), owner, encoding and default collation.
 */
export interface ObservedDatabase {
  readonly oid: string
  readonly owner: string
  readonly encoding: string
  readonly collation: string
}

const DATABASE_FACTS = sql`SELECT d.oid::text AS oid, pg_catalog.pg_get_userbyid(d.datdba) AS owner,
       pg_catalog.pg_encoding_to_char(d.encoding) AS encoding, d.datcollate AS collation
  FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()`

export async function inspectDatabase(
  connector: Connector,
  clusterId: string,
  database: string,
  role: AccessRole,
): Promise<ObservedDatabase> {
  let opened: Awaited<ReturnType<Connector['open']>>
  try {
    opened = await connector.open({ clusterId, database, role, purpose: `database/${clusterId}` })
  } catch (error) {
    if (error instanceof TargetError && error.sqlstate === '3D000') {
      throw conflict('database_not_found')
    }
    throw error
  }
  try {
    const row = (await opened.session.query(DATABASE_FACTS))[0]
    if (row === undefined) {
      throw conflict('database_not_found')
    }
    return {
      oid: row.text('oid'),
      owner: row.text('owner'),
      encoding: row.text('encoding'),
      collation: row.text('collation'),
    }
  } finally {
    await opened.session.close()
  }
}
