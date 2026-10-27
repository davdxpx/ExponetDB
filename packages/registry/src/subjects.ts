import type { Queryable } from '@exponetdb/control-store'
import { tierOf } from './records.ts'

/**
 * Authorization subject chains from the registry (authorization.md §3, §5):
 * the server resolves a subject to its product, project, environment,
 * target and tier, never from the request. The shape is the one the
 * central authorization engine covers bindings with (structurally its
 * `SubjectChain`; the registry does not import the auth package).
 *
 * - A target: its product, project, environment and the environment's tier.
 * - A product: the product only (product bindings and global ones cover it).
 * - A project: product and project.
 * - An environment: product, environment and its tier.
 * - A cluster or a server: no product chain (it can host several products),
 *   so only global bindings cover it; its tier is the derived tier (the
 *   highest tier of the live targets on it), absent while it hosts none. A
 *   cluster also carries its declared intended tier (`cluster.declaredTier`,
 *   OD-22; null while undeclared), from which the engine derives the
 *   registry tier of `registry.manage` (authorization.md §5.1).
 * - A target path that is not registered yet (a `target.register` plan):
 *   product, project, environment and tier from the slugs; the tier must be
 *   the plan's.
 *
 * `undefined`: the subject does not exist; the engine denies (fail closed).
 */
export interface RegistryChain {
  readonly productId?: string
  readonly projectId?: string
  readonly environmentId?: string
  readonly targetId?: string
  readonly tier?: 'prod' | 'nonprod'
  /** Registry facts of a cluster subject: its declared intended tier (OD-22; null while undeclared). */
  readonly cluster?: { readonly declaredTier: 'prod' | 'nonprod' | null }
}

export interface RegistryChains {
  target(targetId: string): Promise<RegistryChain | undefined>
  targetPath(path: string): Promise<RegistryChain | undefined>
  product(productId: string): Promise<RegistryChain | undefined>
  project(projectId: string): Promise<RegistryChain | undefined>
  environment(environmentId: string): Promise<RegistryChain | undefined>
  cluster(clusterId: string): Promise<RegistryChain | undefined>
  server(serverId: string): Promise<RegistryChain | undefined>
}

function tiered(chain: Omit<RegistryChain, 'tier'>, tier: string | null): RegistryChain {
  const t = tierOf(tier)
  return t === null ? chain : { ...chain, tier: t }
}

export function registryChains(q: Queryable): RegistryChains {
  return {
    async target(targetId) {
      const { rows } = await q.query(
        'registry.chain.target',
        `SELECT t.target_id, j.product_id, t.project_id, t.environment_id, t.tier
           FROM registry.targets t JOIN registry.projects j ON j.project_id = t.project_id
          WHERE t.target_id = $1`,
        [targetId],
      )
      const row = rows[0]
      return row === undefined
        ? undefined
        : tiered(
            {
              productId: row.text('product_id'),
              projectId: row.text('project_id'),
              environmentId: row.text('environment_id'),
              targetId: row.text('target_id'),
            },
            row.text('tier'),
          )
    },
    async targetPath(path) {
      const parts = path.split('/')
      if (parts.length !== 3) return undefined
      const { rows } = await q.query(
        'registry.chain.path',
        `SELECT pr.product_id, j.project_id, e.environment_id, e.tier
           FROM registry.products pr
           JOIN registry.projects j ON j.product_id = pr.product_id AND j.slug = $2
           JOIN registry.environments e ON e.product_id = pr.product_id AND e.slug = $3
          WHERE pr.slug = $1`,
        [parts[0], parts[1], parts[2]],
      )
      const row = rows[0]
      return row === undefined
        ? undefined
        : tiered(
            {
              productId: row.text('product_id'),
              projectId: row.text('project_id'),
              environmentId: row.text('environment_id'),
            },
            row.text('tier'),
          )
    },
    async product(productId) {
      const { rows } = await q.query(
        'registry.chain.product',
        'SELECT product_id FROM registry.products WHERE product_id = $1',
        [productId],
      )
      return rows.length === 0 ? undefined : { productId }
    },
    async project(projectId) {
      const { rows } = await q.query(
        'registry.chain.project',
        'SELECT product_id FROM registry.projects WHERE project_id = $1',
        [projectId],
      )
      const row = rows[0]
      return row === undefined ? undefined : { productId: row.text('product_id'), projectId }
    },
    async environment(environmentId) {
      const { rows } = await q.query(
        'registry.chain.environment',
        'SELECT product_id, tier FROM registry.environments WHERE environment_id = $1',
        [environmentId],
      )
      const row = rows[0]
      return row === undefined
        ? undefined
        : tiered({ productId: row.text('product_id'), environmentId }, row.text('tier'))
    },
    async cluster(clusterId) {
      const { rows } = await q.query(
        'registry.chain.cluster',
        `SELECT ct.derived_tier, c.declared_tier
           FROM registry.cluster_tiers ct JOIN registry.clusters c ON c.cluster_id = ct.cluster_id
          WHERE ct.cluster_id = $1`,
        [clusterId],
      )
      const row = rows[0]
      if (row === undefined) return undefined
      const derived = row.textOrNull('derived_tier')
      const declared = row.textOrNull('declared_tier')
      // A cluster is production when either its targets or its declaration say so (Wave 9 Part B
      // review F-2): a nonprod grant never reaches a cluster declared prod that hosts only
      // staging targets yet. Otherwise the derived tier, else the declared one.
      const effective = derived === 'prod' || declared === 'prod' ? 'prod' : (derived ?? declared)
      return tiered({ cluster: { declaredTier: tierOf(declared) } }, effective)
    },
    async server(serverId) {
      const { rows } = await q.query(
        'registry.chain.server',
        'SELECT derived_tier FROM registry.server_tiers WHERE server_id = $1',
        [serverId],
      )
      const row = rows[0]
      return row === undefined ? undefined : tiered({}, row.textOrNull('derived_tier'))
    },
  }
}
