/** S4: the scopes of the first-party CLI that a built-in role's permissions allow (space separated). Usage: scopes-for.ts <role> [--no-prod] */
import { BUILT_IN_ROLES, isScopeGrantableTo, SCOPE_IDS, SCOPES } from '@exponetdb/contracts'

const role = process.argv[2] ?? 'viewer'
const noProd = process.argv.includes('--no-prod')
const perms = new Set<string>((BUILT_IN_ROLES as Record<string, { permissions: readonly string[] }>)[role]?.permissions ?? [])
const out = SCOPE_IDS.filter((s) => {
  if (!isScopeGrantableTo(s, 'cli')) return false
  const def = (SCOPES as Record<string, { permission: string | null; tier: string | null }>)[s]
  if (def === undefined) return false
  if (noProd && def.tier === 'prod') return false
  return def.permission === null || perms.has(def.permission)
})
console.log(out.join(' '))
