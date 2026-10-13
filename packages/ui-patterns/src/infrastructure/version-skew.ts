export type VersionRelation = 'same' | 'older' | 'newer' | 'different'

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)/

/**
 * How a reported version relates to an expected one. Versions of the form
 * `major.minor.patch` (a leading `v` and a suffix such as `-rc.1` are allowed)
 * are compared as numbers; any other text is compared for equality only, so an
 * unparseable version is reported as different and never guessed to be older.
 */
export function versionRelation(actual: string, expected: string): VersionRelation {
  if (actual === expected) return 'same'
  const a = SEMVER.exec(actual)
  const e = SEMVER.exec(expected)
  if (a === null || e === null) return 'different'
  for (let part = 1; part <= 3; part += 1) {
    const left = Number(a[part])
    const right = Number(e[part])
    if (left < right) return 'older'
    if (left > right) return 'newer'
  }
  return 'different'
}
