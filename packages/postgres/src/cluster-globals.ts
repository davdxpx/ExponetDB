import type { ClusterGlobalCondition, ClusterGlobalExpectation } from './parser/cluster-global.ts'
import type { CatalogReader } from './session.ts'
import { sql } from './sql.ts'

/**
 * The imported target's cluster-global catalog against what elided legacy
 * role statements stated ([`legacy-import.md` §2.4](../../../exponetdb-docs/04-migrations/legacy-import.md#24-files-with-cluster-global-effects)):
 * `pg_roles`, `pg_auth_members` (with `ADMIN`, `INHERIT`, `SET` on 16+),
 * `pg_db_role_setting` and the roles' shared comments. Every role may read
 * these catalogs; the observer does. Passwords are never read.
 */
export interface ClusterGlobalResult {
  readonly expectation: ClusterGlobalExpectation
  /**
   * `false`: an `IF EXISTS` guard of the statement does not hold on the
   * target, so the expectation is not checked (`ok` is then `false` too).
   */
  readonly applies: boolean
  readonly ok: boolean
  /**
   * OD-56 (a): when it applies and does not hold, the keyed digest of the
   * value observed for a value kind (a role attribute, connection limit,
   * comment, membership option or setting; `null` when the role or the
   * membership is missing). Only with a digest function; never the value.
   */
  readonly observedDigest?: string
}

/** Keys what a failing cluster-global check observed (the expectation, and the value's canonical text). */
export type ClusterGlobalValueDigest = (
  expectation: ClusterGlobalExpectation,
  observation: string,
) => string

const ROLES = sql`SELECT r.rolname::text AS role, r.rolcanlogin AS login, r.rolsuper AS superuser,
       r.rolcreatedb AS createdb, r.rolcreaterole AS createrole, r.rolreplication AS replication,
       r.rolbypassrls AS bypassrls, r.rolinherit AS inherit, r.rolconnlimit::text AS connection_limit,
       pg_catalog.shobj_description(r.oid, 'pg_authid') AS comment
  FROM pg_catalog.pg_roles r
 WHERE r.rolname = ANY (ARRAY(SELECT pg_catalog.jsonb_array_elements_text($1::jsonb)))`

const MEMBERSHIPS = sql`SELECT g.rolname::text AS role, u.rolname::text AS member,
       bool_or(m.admin_option) AS admin, bool_or(m.inherit_option) AS inherit, bool_or(m.set_option) AS set
  FROM pg_catalog.pg_auth_members m
  JOIN pg_catalog.pg_roles g ON g.oid = m.roleid
  JOIN pg_catalog.pg_roles u ON u.oid = m.member
 WHERE g.rolname = ANY (ARRAY(SELECT pg_catalog.jsonb_array_elements_text($1::jsonb)))
 GROUP BY g.rolname, u.rolname`

const SETTINGS = sql`SELECT coalesce(r.rolname::text, '') AS role, coalesce(d.datname::text, '') AS database,
       pg_catalog.array_to_json(s.setconfig)::text AS config
  FROM pg_catalog.pg_db_role_setting s
  LEFT JOIN pg_catalog.pg_roles r ON r.oid = s.setrole
  LEFT JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase
 WHERE s.setrole = 0
    OR r.rolname = ANY (ARRAY(SELECT pg_catalog.jsonb_array_elements_text($1::jsonb)))`

const pair = (role: string, member: string) => `${role}\u0000${member}`

/** Checks each expectation against the live catalog, in order. */
export async function checkClusterGlobalExpectations(
  reader: CatalogReader,
  expectations: readonly ClusterGlobalExpectation[],
  options: { readonly valueDigest?: ClusterGlobalValueDigest } = {},
): Promise<ClusterGlobalResult[]> {
  if (expectations.length === 0) return []
  const names = new Set<string>()
  for (const e of expectations) {
    for (const x of [e, ...(e.when ?? [])]) {
      if (x.kind === 'membership' || x.kind === 'membership_option') {
        names.add(x.role)
        names.add(x.member)
      } else if (x.role !== null) {
        names.add(x.role)
      }
    }
  }
  const param = JSON.stringify([...names].sort())
  const roles = new Map((await reader.query(ROLES, [param])).map((r) => [r.text('role'), r]))
  const members = new Map(
    (await reader.query(MEMBERSHIPS, [param])).map((r) => [
      pair(r.text('role'), r.text('member')),
      r,
    ]),
  )
  const settings = new Map<string, Map<string, string>>()
  for (const r of await reader.query(SETTINGS, [param])) {
    const entries = new Map<string, string>()
    for (const item of r.jsonArray('config')) {
      if (typeof item !== 'string') continue
      const at = item.indexOf('=')
      if (at > 0) entries.set(item.slice(0, at).toLowerCase(), item.slice(at + 1))
    }
    settings.set(pair(r.text('role'), r.text('database')), entries)
  }
  return expectations.map((e) => {
    const applies = (e.when ?? []).every(holds)
    const ok = applies && holds(e)
    const value = applies && !ok ? observed(e) : undefined
    const digest =
      value === undefined || options.valueDigest === undefined
        ? undefined
        : options.valueDigest(e, JSON.stringify({ value }))
    return {
      expectation: e,
      applies,
      ok,
      ...(digest === undefined ? {} : { observedDigest: digest }),
    }
  })

  /** What a value kind observed (OD-56 (a)); `undefined` for an existence kind. */
  function observed(e: ClusterGlobalExpectation): string | number | boolean | null | undefined {
    switch (e.kind) {
      case 'role':
      case 'membership':
        return undefined
      case 'role_attribute':
        return roles.get(e.role)?.bool(e.attribute) ?? null
      case 'role_connection_limit':
        return roles.get(e.role)?.int('connection_limit') ?? null
      case 'role_comment':
        return roles.get(e.role)?.textOrNull('comment') ?? null
      case 'membership_option':
        return members.get(pair(e.role, e.member))?.boolOrNull(e.option) ?? null
      case 'role_setting':
        return settings.get(pair(e.role ?? '', e.database ?? ''))?.get(e.name.toLowerCase()) ?? null
    }
  }

  function holds(e: ClusterGlobalExpectation | ClusterGlobalCondition): boolean {
    switch (e.kind) {
      case 'role':
        return roles.has(e.role) === e.exists
      case 'role_attribute': {
        const r = roles.get(e.role)
        return r !== undefined && r.bool(e.attribute) === e.value
      }
      case 'role_connection_limit': {
        const r = roles.get(e.role)
        return r !== undefined && r.int('connection_limit') === e.value
      }
      case 'role_comment': {
        const r = roles.get(e.role)
        return r !== undefined && r.textOrNull('comment') === e.value
      }
      case 'membership':
        return members.has(pair(e.role, e.member)) === e.exists
      case 'membership_option': {
        const m = members.get(pair(e.role, e.member))
        // Without the membership, no option is granted.
        return m === undefined ? !e.value : (m.boolOrNull(e.option) ?? false) === e.value
      }
      case 'role_setting': {
        const entries = settings.get(pair(e.role ?? '', e.database ?? ''))
        const value = entries?.get(e.name.toLowerCase())
        return e.value === null ? value === undefined : value === e.value
      }
    }
  }
}
