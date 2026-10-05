import { dictionary } from '@zxcvbn-ts/language-common'

/**
 * Offline common-password check (identity.md §2). No password and no part
 * of it ever leaves ExponetDB: there is no range query to an online
 * service.
 *
 * Source: the `passwords-common` dictionary of `@zxcvbn-ts/language-common`
 * 4.1.3 (MIT license, © Dropbox and the zxcvbn-ts authors), 49,233 entries
 * as shipped in the pinned package; updated by updating that pinned
 * dependency in a reviewed change. [ASSUMPTION] The zxcvbn project derives
 * its list from public password-frequency data; ExponetDB did not re-derive
 * it. It is a bundled top-N list of common and breached passwords, **not**
 * a complete breach corpus: a password that appeared in a breach but not
 * in this list passes.
 */
let common: ReadonlySet<string> | undefined

function list(): ReadonlySet<string> {
  if (common === undefined) {
    const words = dictionary['passwords-common']
    common = new Set(Array.isArray(words) ? words.map((w) => String(w).toLowerCase()) : [])
  }
  return common
}

export function commonPasswordCount(): number {
  return list().size
}

const AFFIX = /[0-9!?.#*_+@$%&-]+/

/**
 * True when the password, compared case-insensitively, is a listed
 * password, a listed password with only digits or punctuation added before
 * or after it, a listed password repeated, or a single repeated character.
 */
export function isCommonPassword(password: string): boolean {
  const lower = password.toLowerCase()
  const words = list()
  if (/^(.)\1*$/su.test(lower)) {
    return true
  }
  const candidates = new Set<string>([
    lower,
    lower.replace(new RegExp(`${AFFIX.source}$`), ''),
    lower.replace(new RegExp(`^${AFFIX.source}`), ''),
    lower.replace(new RegExp(`^${AFFIX.source}`), '').replace(new RegExp(`${AFFIX.source}$`), ''),
  ])
  for (const candidate of candidates) {
    if (candidate.length >= 4 && words.has(candidate)) {
      return true
    }
  }
  for (let size = 4; size <= lower.length / 2; size++) {
    if (lower.length % size === 0) {
      const unit = lower.slice(0, size)
      if (unit.repeat(lower.length / size) === lower && words.has(unit)) {
        return true
      }
    }
  }
  return false
}
