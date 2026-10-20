import type { PageBreadcrumbItem } from '@exponetdb/ui-patterns'
import { isSchemaKind, parseTargetParams } from '../features/target/params.ts'
import { ULID } from '../lib/navigation/links.ts'
import { GLOBAL_NAV, NAV_SECTIONS, TARGET_NAV, targetHref } from './navigation.ts'

/**
 * The breadcrumb trail of a detail page, derived from the route that is
 * matched and its parameters (information-architecture.md section 2): the
 * labels are the navigation's own (`NAV_SECTIONS`, `GLOBAL_NAV`, `TARGET_NAV`),
 * the last crumb is the typed id or schema kind of the page, and every link
 * leads to a parent route of the page, built from the navigation's paths and
 * the validated slugs, never from text. A parameter that fails its grammar
 * (an id that is not `pln_<ULID>`, a slug that is not a slug, a kind that is not
 * a schema kind) gives no trail at all: the page itself renders "not found" for
 * it, and nothing of the address is shown.
 */

const sectionLabel = (id: string): string =>
  NAV_SECTIONS.find((section) => section.id === id)?.label ?? id

const pageLabel = (id: string): string => GLOBAL_NAV.find((item) => item.id === id)?.label ?? id

const targetLabel = (id: string): string => TARGET_NAV.find((item) => item.id === id)?.label ?? id

interface IdTrail {
  /** The route parameter that holds the id. */
  readonly param: string
  /** The prefix of the id (`pln` for `pln_<ULID>`). */
  readonly prefix: string
  readonly section: { readonly label: string; readonly href: string }
  readonly list: { readonly label: string; readonly href: string }
}

/** The detail pages of the global level, by route id (a map, so no route id can name a prototype member). */
const ID_TRAILS: ReadonlyMap<string, IdTrail> = new Map<string, IdTrail>(
  Object.entries({
    '/_app/changes/plans/$planId': {
      param: 'planId',
      prefix: 'pln',
      section: { label: sectionLabel('changes'), href: '/changes' },
      list: { label: pageLabel('plans'), href: '/changes/plans' },
    },
    '/_app/changes/operations/$operationId': {
      param: 'operationId',
      prefix: 'op',
      section: { label: sectionLabel('changes'), href: '/changes' },
      list: { label: pageLabel('operations'), href: '/changes/operations' },
    },
    '/_app/infrastructure/servers/$serverId': {
      param: 'serverId',
      prefix: 'srv',
      section: { label: sectionLabel('infrastructure'), href: '/infrastructure/servers' },
      list: { label: pageLabel('servers'), href: '/infrastructure/servers' },
    },
    '/_app/infrastructure/clusters/$clusterId': {
      param: 'clusterId',
      prefix: 'cls',
      section: { label: sectionLabel('infrastructure'), href: '/infrastructure/servers' },
      list: { label: pageLabel('clusters'), href: '/infrastructure/clusters' },
    },
    '/_app/infrastructure/nodes/$nodeId': {
      param: 'nodeId',
      prefix: 'nod',
      section: { label: sectionLabel('infrastructure'), href: '/infrastructure/servers' },
      list: { label: pageLabel('nodes'), href: '/infrastructure/nodes' },
    },
  }),
)

const TARGET_KIND_ROUTE = '/_app/t/$product/$project/$environment/schema/$kind'

function idOf(prefix: string, value: unknown): string | undefined {
  return typeof value === 'string' && new RegExp(`^${prefix}_${ULID}$`).test(value)
    ? value
    : undefined
}

/** A crumb that links to the page the next crumb also links to adds nothing: it is shown as text. */
function withoutRepeatedLinks(
  crumbs: readonly PageBreadcrumbItem[],
): readonly PageBreadcrumbItem[] {
  return crumbs.map((crumb, index) =>
    crumb.href !== undefined && crumbs[index + 1]?.href === crumb.href
      ? { label: crumb.label }
      : crumb,
  )
}

/**
 * The trail for the matched route, or `undefined` for a page that has none
 * (only detail pages do) or whose parameters do not pass their grammar.
 */
export function breadcrumbTrail(
  routeId: string,
  params: Readonly<Record<string, unknown>>,
): readonly PageBreadcrumbItem[] | undefined {
  const idTrail = ID_TRAILS.get(routeId)
  if (idTrail !== undefined) {
    const id = idOf(idTrail.prefix, params[idTrail.param])
    if (id === undefined) return undefined
    return withoutRepeatedLinks([idTrail.section, idTrail.list, { label: id }])
  }
  if (routeId === TARGET_KIND_ROUTE) {
    const target = parseTargetParams({
      product: strOrUndefined(params['product']),
      project: strOrUndefined(params['project']),
      environment: strOrUndefined(params['environment']),
    })
    const kind = params['kind']
    if (target === undefined || !isSchemaKind(kind)) return undefined
    return [
      { label: sectionLabel('targets'), href: '/targets' },
      { label: target.path, href: targetHref(target) },
      { label: targetLabel('schema'), href: targetHref(target, '/schema') },
      { label: kind.replaceAll('-', ' ') },
    ]
  }
  return undefined
}

function strOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
