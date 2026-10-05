import { type InstallationId, isId } from '@exponetdb/kernel'
import { ControlStoreError } from './errors.ts'
import type { Queryable } from './store.ts'

/**
 * The installation marker ([control-database.md §6](../../../exponetdb-docs/02-control-plane/control-database.md#6-self-management-boundary)):
 * exactly one row, written by the first successful migration run, immutable
 * (a trigger refuses UPDATE, DELETE and TRUNCATE). A second run finds it and
 * keeps it; a process configured with another installation id refuses to start.
 */
export async function readInstallationId(q: Queryable): Promise<InstallationId | undefined> {
  const probe = await q.query(
    'installation.probe',
    `SELECT to_regclass('control.installation') IS NOT NULL AS present`,
  )
  if (probe.rows[0]?.bool('present') !== true) {
    return undefined
  }
  const { rows } = await q.query(
    'installation.read',
    'SELECT installation_id FROM control.installation',
  )
  const value = rows[0]?.text('installation_id')
  if (value === undefined) {
    return undefined
  }
  if (!isId('ins', value)) {
    throw new ControlStoreError('control_store_invalid_result')
  }
  return value
}

/** Writes the marker once; returns the stored id (the existing one on later runs). */
export async function ensureInstallation(
  q: Queryable,
  candidate: InstallationId,
  engineVersion: string,
): Promise<InstallationId> {
  await q.query(
    'installation.ensure',
    `INSERT INTO control.installation (installation_id, created_by_engine) VALUES ($1, $2)
     ON CONFLICT (singleton) DO NOTHING`,
    [candidate, engineVersion],
  )
  const stored = await readInstallationId(q)
  if (stored === undefined) {
    throw new ControlStoreError('control_store_invalid_result')
  }
  return stored
}
