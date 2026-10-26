import type { Product, Project, TargetSummary } from '@exponetdb/sdk/operations'
import { splitTargetPath } from '../target/params.ts'
import { HEALTH_RANK, type HealthFilter, healthOf } from '../targets/model.ts'

/**
 * The projects portfolio (`/projects`) and a project's home (`/p/<product>/<project>`) as pure
 * functions: the URL contract of the list, and the join of the three bounded reads the pages
 * make (projects, products, targets), so the number of requests never grows with the number of
 * projects. Unit-tested.
 */

export const PROJECT_VIEWS = ['grid', 'table'] as const
export type ProjectView = (typeof PROJECT_VIEWS)[number]
export const PROJECT_SEARCH_MAX_LENGTH = 100
/** Cards per page of the grid and rows per page of the table. */
export const PROJECT_PAGE_SIZE: Readonly<Record<ProjectView, number>> = { grid: 24, table: 50 }

export interface ProjectsSearch {
  /** Matches the display name or the path, case-insensitively; at most 100 characters. */
  readonly q?: string | undefined
  /** A product slug. */
  readonly product?: string | undefined
  readonly view?: ProjectView | undefined
  /** 1-based. */
  readonly page?: number | undefined
}

const SLUG = /^[a-z][a-z0-9-]{0,38}$/

/**
 * The validated search of `/projects`. Every key is present, `undefined` when its value is outside
 * the grammar: the router merges the raw search of the parent routes into a route's validated
 * search, so a key left out here would arrive unchecked.
 */
export function projectsSearch(search: Readonly<Record<string, unknown>>): ProjectsSearch {
  const q = typeof search['q'] === 'string' ? search['q'].slice(0, PROJECT_SEARCH_MAX_LENGTH) : ''
  const product = search['product']
  const view = search['view']
  const page = Number(search['page'])
  return {
    q: q.trim() === '' ? undefined : q,
    product: typeof product === 'string' && SLUG.test(product) ? product : undefined,
    view: view === 'table' || view === 'grid' ? view : undefined,
    page: Number.isInteger(page) && page > 1 && page < 100_000 ? page : undefined,
  }
}

/** One environment of a project as its card shows it: the target's summary and its slug. */
export interface ProjectEnvironment {
  readonly slug: string
  readonly target: TargetSummary
}

export interface ProjectRow {
  readonly project: Project
  /** The product's display name, when the product list had it. */
  readonly productName: string | null
  readonly productSlug: string
  readonly projectSlug: string
  /** Its targets in the list read, nonproduction first, then by slug; decommissioned ones last. */
  readonly environments: readonly ProjectEnvironment[]
  /** Environments whose health needs a person (not healthy, not suspended, not decommissioned). */
  readonly attention: number
  /** The worst health among its live environments, for sorting and the card's edge. */
  readonly worst: HealthFilter | undefined
}

const NO_ATTENTION: ReadonlySet<HealthFilter> = new Set<HealthFilter>(['healthy', 'suspended'])

function environmentOrder(a: ProjectEnvironment, b: ProjectEnvironment): number {
  const gone = (e: ProjectEnvironment) => (e.target.state === 'decommissioned' ? 1 : 0)
  const prod = (e: ProjectEnvironment) => (e.target.tier === 'nonprod' ? 0 : 1)
  return gone(a) - gone(b) || prod(a) - prod(b) || a.slug.localeCompare(b.slug)
}

/** The environments of one project among the targets read (paths that are not three slugs are left out). */
export function environmentsOf(
  targets: readonly TargetSummary[],
  projectId: string,
): readonly ProjectEnvironment[] {
  return targets
    .filter((target) => target.projectId === projectId)
    .flatMap((target) => {
      const route = splitTargetPath(target.path)
      return route === undefined ? [] : [{ slug: route.environment, target }]
    })
    .sort(environmentOrder)
}

function attentionOf(environments: readonly ProjectEnvironment[]): {
  readonly attention: number
  readonly worst: HealthFilter | undefined
} {
  const live = environments.filter((e) => e.target.state !== 'decommissioned')
  const needing = live.filter((e) => !NO_ATTENTION.has(healthOf(e.target)))
  const worst = [...live]
    .map((e) => healthOf(e.target))
    .sort((a, b) => (HEALTH_RANK[a] ?? 0) - (HEALTH_RANK[b] ?? 0))[0]
  return { attention: needing.length, worst }
}

/** The rows of the portfolio: every project read, with its product and the environments read. */
export function projectRows(
  projects: readonly Project[],
  products: readonly Product[] | undefined,
  targets: readonly TargetSummary[] | undefined,
): readonly ProjectRow[] {
  const productById = new Map((products ?? []).map((product) => [product.id, product]))
  return projects
    .flatMap((project) => {
      const [productSlug, projectSlug] = project.path.split('/')
      if (productSlug === undefined || projectSlug === undefined) return []
      if (!SLUG.test(productSlug) || !SLUG.test(projectSlug)) return []
      const environments = targets === undefined ? [] : environmentsOf(targets, project.id)
      return [
        {
          project,
          productName: productById.get(project.productId)?.displayName ?? null,
          productSlug,
          projectSlug,
          environments,
          ...attentionOf(environments),
        },
      ]
    })
    .sort((a, b) => a.project.path.localeCompare(b.project.path))
}

/** The rows that match the search: product slug, then the text in the display name or path. */
export function filterProjects(
  rows: readonly ProjectRow[],
  search: ProjectsSearch,
): readonly ProjectRow[] {
  const needle = search.q?.trim().toLowerCase() ?? ''
  return rows.filter(
    (row) =>
      (search.product === undefined || row.productSlug === search.product) &&
      (needle === '' ||
        row.project.path.includes(needle) ||
        row.project.displayName.toLowerCase().includes(needle)),
  )
}

/** The products the filter offers: the slugs of the projects read, with a name where it was read. */
export function productChoices(
  rows: readonly ProjectRow[],
): readonly { readonly slug: string; readonly name: string | null }[] {
  const seen = new Map<string, string | null>()
  for (const row of rows) {
    if (!seen.has(row.productSlug)) seen.set(row.productSlug, row.productName)
  }
  return [...seen]
    .map(([slug, name]) => ({ slug, name }))
    .sort((a, b) => a.slug.localeCompare(b.slug))
}

/** The project at `<product>/<project>` among the rows read, if the read holds it. */
export function findProject(
  rows: readonly ProjectRow[],
  product: string,
  project: string,
): ProjectRow | undefined {
  return rows.find((row) => row.productSlug === product && row.projectSlug === project)
}

/** The environments of `<product>/<project>` in a target list the server filtered by both. */
export function projectEnvironments(
  targets: readonly TargetSummary[],
  product: string,
  project: string,
): readonly ProjectEnvironment[] {
  return targets
    .flatMap((target) => {
      const route = splitTargetPath(target.path)
      return route === undefined || route.product !== product || route.project !== project
        ? []
        : [{ slug: route.environment, target }]
    })
    .sort(environmentOrder)
}

export interface StreamRow {
  readonly slug: string
  readonly tier: 'prod' | 'nonprod'
  /** The live target's path in this environment; null when there is none the person may see. */
  readonly targetPath: string | null
  readonly verified: number
  /** Applied without a passed verification. */
  readonly applied: number
  readonly notApplied: number
  /** The mirror holds nothing for the cell: unknown, never "not applied". */
  readonly unknown: number
  /** Failed verification, divergent or reverted. */
  readonly failed: number
}

interface StreamLike {
  readonly environments: readonly {
    readonly slug: string
    readonly tier: 'prod' | 'nonprod'
    readonly target: { readonly path: string } | null
  }[]
  readonly bundles: readonly {
    readonly states: readonly { readonly environment: string; readonly state: string }[]
  }[]
}

/** Per environment, in the stream's evidence order, how its cells of the stream stand. */
export function streamRows(stream: StreamLike): readonly StreamRow[] {
  return stream.environments.map((environment) => {
    const counts = { verified: 0, applied: 0, notApplied: 0, unknown: 0, failed: 0 }
    for (const bundle of stream.bundles) {
      const cell = bundle.states.find((state) => state.environment === environment.slug)
      switch (cell?.state) {
        case 'verified':
          counts.verified += 1
          break
        case 'applied':
          counts.applied += 1
          break
        case 'not_applied':
          counts.notApplied += 1
          break
        case 'failed':
        case 'divergent':
        case 'reverted':
          counts.failed += 1
          break
        default:
          // No cell, `unknown` or a state this version does not know: never "not applied".
          counts.unknown += 1
      }
    }
    return {
      slug: environment.slug,
      tier: environment.tier,
      targetPath: environment.target?.path ?? null,
      ...counts,
    }
  })
}
