import type { Queryable } from '@exponetdb/control-store'
import { isJsonObject, parseJson } from '@exponetdb/kernel'
import { SCOPE_KINDS, type SettingRow, type SubjectScope } from '@exponetdb/policy'

/**
 * Reads the policy settings rows that apply to a subject from
 * `policy.rule_settings` ([policy-engine.md §5.2](../../../exponetdb-docs/02-control-plane/policy-engine.md#52-configuration-storage)).
 * The policy package resolves them; it never touches the Control Store.
 */
export async function readPolicySettings(
  q: Queryable,
  subject: SubjectScope,
): Promise<SettingRow[]> {
  const scopes: [string, string][] = [['installation', 'installation']]
  if (subject.productId !== undefined) {
    scopes.push(['product', subject.productId])
  }
  if (subject.projectId !== undefined) {
    scopes.push(['project', subject.projectId])
  }
  if (subject.environmentId !== undefined) {
    scopes.push(['environment', subject.environmentId])
  }
  if (subject.targetId !== undefined) {
    scopes.push(['target', subject.targetId])
  }
  const { rows } = await q.query(
    'operations.policy_settings.read',
    `SELECT s.scope_kind, s.scope_id, s.rule_id, s.revision, s.params::text AS params
       FROM policy.rule_settings s
       JOIN unnest($1::text[], $2::text[]) AS w(kind, id) ON w.kind = s.scope_kind AND w.id = s.scope_id
      ORDER BY s.rule_id, s.scope_kind, s.revision`,
    [scopes.map(([k]) => k), scopes.map(([, id]) => id)],
  )
  const out: SettingRow[] = []
  for (const row of rows) {
    const kind = SCOPE_KINDS.find((k) => k === row.text('scope_kind'))
    const params = parseJson(row.text('params'))
    if (kind === undefined || !params.ok || !isJsonObject(params.value)) {
      continue
    }
    out.push({
      scopeKind: kind,
      scopeId: row.text('scope_id'),
      ruleId: row.text('rule_id'),
      revision: row.int('revision'),
      params: params.value,
    })
  }
  return out
}
