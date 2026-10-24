import { t } from '../../lib/i18n/i18n.ts'
import type { TargetList } from '../targets/keys.ts'
import type { Lifecycle, Tier } from './environments.ts'
import { splitTargetPath, type TargetRoute } from './params.ts'

/**
 * The databases the switcher offers (the context bar's popover and the
 * "Switch database" command page), as a pure function of the target list
 * read: grouped by product and project, nonproduction first within a group.
 * The tier is the target's `tier` field, never a guess from its slug, and a
 * path that is not three slugs is left out and reported as missing (it
 * cannot be shown or linked safely), like the environment list does.
 */
export interface Database {
  readonly id: string
  /** `<product>/<project>/<environment>`, three validated slugs. */
  readonly path: string
  readonly route: TargetRoute
  readonly tier: Tier
  readonly state: Lifecycle
}

export interface DatabaseGroup {
  /** `<product>/<project>`. */
  readonly key: string
  readonly product: string
  readonly project: string
  readonly databases: readonly Database[]
}

export interface DatabaseGroups {
  readonly groups: readonly DatabaseGroup[]
  readonly byPath: ReadonlyMap<string, Database>
  /** What the list does not hold, in words (a partial read); empty when it is complete. */
  readonly missing: readonly string[]
  /** Whether the server has more targets than the read followed. */
  readonly truncated: boolean
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export function toDatabaseGroups(list: TargetList): DatabaseGroups {
  const byPath = new Map<string, Database>()
  const grouped = new Map<string, { product: string; project: string; databases: Database[] }>()
  let unreadable = 0
  for (const item of list.items) {
    const route = splitTargetPath(item.path)
    if (route === undefined || byPath.has(route.path)) {
      unreadable += 1
      continue
    }
    const database: Database = {
      id: item.id,
      path: route.path,
      route,
      tier: item.tier,
      state: item.state,
    }
    byPath.set(route.path, database)
    const key = `${route.product}/${route.project}`
    const group = grouped.get(key) ?? {
      product: route.product,
      project: route.project,
      databases: [],
    }
    group.databases.push(database)
    grouped.set(key, group)
  }
  const groups = [...grouped.entries()]
    .sort(([a], [b]) => compare(a, b))
    .map(([key, group]) => ({
      key,
      product: group.product,
      project: group.project,
      databases: group.databases.sort(
        (a, b) =>
          Number(a.tier === 'prod') - Number(b.tier === 'prod') ||
          compare(a.route.environment, b.route.environment),
      ),
    }))
  const missing: string[] = []
  if (list.more) missing.push(t('target.switch.missing.more'))
  if (unreadable > 0) missing.push(t('target.switch.missing.unreadable'))
  return { groups, byPath, missing, truncated: list.more }
}

/** A database the person opened lately: known from the list, or only by its path. */
export interface RecentDatabase {
  readonly path: string
  readonly route: TargetRoute
  /** `undefined` when the list read does not hold it (the tier is then not known). */
  readonly database: Database | undefined
}

/**
 * The recent databases to offer, newest first. A path the list read holds is
 * shown with what the list says; a path it does not hold is dropped when the
 * read is complete (it is gone or no longer visible) and kept, with its tier
 * unknown, when the read is partial (it may be among the databases not read).
 */
export function recentDatabases(
  recent: readonly string[],
  groups: DatabaseGroups,
): readonly RecentDatabase[] {
  const shown: RecentDatabase[] = []
  for (const path of recent) {
    const route = splitTargetPath(path)
    if (route === undefined) continue
    const database = groups.byPath.get(path)
    if (database !== undefined) shown.push({ path, route, database })
    else if (groups.truncated) shown.push({ path, route, database: undefined })
  }
  return shown
}
