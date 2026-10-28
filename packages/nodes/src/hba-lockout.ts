import { BlockList, isIP } from 'node:net'
import type { JsonObject, JsonValue } from '@exponetdb/kernel'

/**
 * The plan-time lock-out check of `postgres.hba.apply` (test campaign TC-018): the planned
 * managed rules, first match first, against the access ExponetDB must keep. It mirrors the
 * agent's own check after the write (`matchAccess` in `agent/node/internal/capabilities/hba.go`),
 * which stays the second line. The managed block is placed first in the file, so a rule of it
 * that matches an access decides it. A rule the check cannot judge (`samehost`, `samenet`,
 * `samerole`) ends the check for that access without a verdict: the agent refuses it after the
 * write and puts the file back.
 */

/** 1 match, 0 no match, -1 uncertain (the Go `listMatch`). */
function listMatch(items: readonly JsonValue[], want: string, database: boolean, role: string) {
  let result = 0
  for (const item of items) {
    if (item === 'all') return 1
    if (database && item === 'sameuser') {
      if (role === want) return 1
    } else if (item === 'samerole' || item === 'samegroup') {
      result = -1
    } else if (item === want) {
      return 1
    }
  }
  return result
}

/** 1 match, 0 no match, -1 uncertain, for a network access address against a rule's address. */
function addressMatch(rule: JsonValue | undefined, address: string): number {
  if (rule === 'all') return 1
  if (typeof rule !== 'string' || rule === 'samehost' || rule === 'samenet') return -1
  const [network, prefix] = rule.split('/')
  const family = isIP(network ?? '')
  const accessFamily = isIP(address)
  if (family === 0 || accessFamily === 0 || prefix === undefined) return -1
  if (family !== accessFamily) return 0
  const kind = family === 4 ? 'ipv4' : 'ipv6'
  try {
    const list = new BlockList()
    list.addSubnet(network as string, Number(prefix), kind)
    return list.check(address, kind) ? 1 : 0
  } catch {
    return -1
  }
}

const text = (value: JsonValue | undefined): string => (typeof value === 'string' ? value : '')
const list = (value: JsonValue | undefined): readonly JsonValue[] =>
  Array.isArray(value) ? value : []

/**
 * The first access that the planned rules cut off, as the access plus the 1-based number of the
 * rule that decides it (a `reject`, or a method other than the one the access needs), or
 * `undefined` when every access is kept, is not decided by the managed rules, or cannot be judged.
 */
export function hbaLockOut(
  rules: readonly JsonObject[],
  accesses: readonly JsonObject[],
): JsonObject | undefined {
  for (const access of accesses) {
    const role = text(access['role'])
    const database = text(access['database'])
    const address = text(access['address'])
    const local = address === 'local'
    for (const [index, rule] of rules.entries()) {
      if ((rule['type'] === 'local') !== local) continue
      const db = listMatch(list(rule['database']), database, true, role)
      const user = listMatch(list(rule['user']), role, false, '')
      const addr = local ? 1 : addressMatch(rule['address'], address)
      if (db === 0 || user === 0 || addr === 0) continue
      if (db < 0 || user < 0 || addr < 0) break
      if (rule['method'] !== access['method']) {
        return {
          role,
          database,
          address,
          method: text(access['method']),
          rule: index + 1,
        }
      }
      break
    }
  }
  return undefined
}
