import { canonicalize, InvariantError, type JsonValue } from '@exponetdb/kernel'
import { sha256Hex } from '@exponetdb/kernel/hash'
import type { TargetSession } from '../session.ts'
import { normalize } from './canonical.ts'
import { CLUSTER_MEMBERSHIPS, CLUSTER_ROLES, CLUSTER_SETTINGS, PIN_SETTINGS } from './queries.ts'

/**
 * The cluster fingerprint ([schema-fingerprints.md §3](../../../../exponetdb-docs/03-database-model/schema-fingerprints.md#3-what-is-in-the-document)):
 * roles are cluster-wide and not part of a database fingerprint. This one
 * covers roles (attributes, connection limits, settings), memberships with
 * their `admin`, `inherit` and `set` options, and per-database role settings,
 * as `cfp1:<major>:<sha256>` over the JCS form. Predefined `pg_*` roles are
 * left out; passwords are never read (`pg_roles` shows none).
 */
export interface ClusterFingerprint {
  readonly fingerprint: string
  readonly roles: number
  readonly memberships: number
  readonly settings: number
}

export async function clusterFingerprint(session: TargetSession): Promise<ClusterFingerprint> {
  return session.readOnly(async (tx) => {
    await tx.query(PIN_SETTINGS)
    const [roles, memberships, settings] = [
      await tx.query(CLUSTER_ROLES),
      await tx.query(CLUSTER_MEMBERSHIPS),
      await tx.query(CLUSTER_SETTINGS),
    ]
    const doc: JsonValue = {
      canonicalizer: 'cfp1',
      pgMajor: session.facts.major,
      roles: roles.map(
        (r) =>
          normalize({
            name: r.text('name'),
            superuser: r.bool('superuser'),
            inherit: r.bool('inherit'),
            createrole: r.bool('createrole'),
            createdb: r.bool('createdb'),
            login: r.bool('login'),
            replication: r.bool('replication'),
            bypassrls: r.bool('bypassrls'),
            connectionLimit: r.int('connection_limit'),
            validUntil: r.textOrNull('valid_until'),
            config: r.isNull('config') ? null : r.json('config'),
          }) ?? null,
      ),
      memberships: memberships.map(
        (m) =>
          normalize({
            role: m.text('role'),
            member: m.text('member'),
            grantor: m.text('grantor'),
            admin: m.bool('admin'),
            inherit: m.bool('inherit'),
            set: m.bool('set'),
          }) ?? null,
      ),
      settings: settings.map(
        (s) =>
          normalize({
            database: s.textOrNull('database'),
            role: s.textOrNull('role'),
            config: s.isNull('config') ? null : s.json('config'),
          }) ?? null,
      ),
    }
    const text = canonicalize(doc)
    if (!text.ok) throw new InvariantError('cluster document is I-JSON')
    return {
      fingerprint: `cfp1:${session.facts.major}:${sha256Hex(text.value)}`,
      roles: roles.length,
      memberships: memberships.length,
      settings: settings.length,
    }
  })
}
