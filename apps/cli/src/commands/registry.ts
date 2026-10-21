import { SERVER_PROVIDERS } from '@exponetdb/contracts'
import type { Environment } from '@exponetdb/sdk'
import { EXIT } from '../cli/exit.ts'
import { pairs, planCommand } from '../cli/planning.ts'
import { arg, flag, listCommand, showCommand } from '../cli/reads.ts'
import { must } from '../cli/remote.ts'
import type { CommandInput, CommandSpec, Remote } from '../cli/types.ts'
import { UsageError } from '../cli/usage.ts'
import { WAIT_FLAGS, waits } from '../cli/watch.ts'
import { CliError } from '../errors.ts'
import { ago, dash, header } from '../output/format.ts'
import { result } from '../output/model.ts'

/**
 * The registry ([`15-cli/README.md`](../../../../exponetdb-docs/15-cli/README.md)):
 * products, environments, projects, targets, servers and clusters to read,
 * and the typed plans the server supports for them. Every change is a plan
 * the server makes and decides; `--apply` applies it and waits until it is
 * applied and verified. A credential is never typed into the CLI: the
 * Web App takes it write-only.
 */
const READ = ['targets.read']
const NODES = ['nodes.read']
const MANAGE = ['registry.manage']

const health = (h: { readonly state: string; readonly observedAt: string } | null, now: number) =>
  h === null ? 'unknown' : `${h.state} (${ago(h.observedAt, now)})`

function optional<T>(input: CommandInput, name: string, map: (v: string) => T): Record<string, T> {
  const v = flag(input, name)
  return v === undefined ? {} : { [toKey(name)]: map(v) }
}

const toKey = (flagName: string) => flagName.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

const tierOf = (v: string): 'prod' | 'nonprod' => {
  if (v !== 'prod' && v !== 'nonprod') throw new UsageError('--tier is prod or nonprod.')
  return v
}

/**
 * A product reference as the server takes it: an id passes through; a slug
 * is looked up among the products the caller may read (not found is an
 * error naming the slug, never a guess).
 */
async function productRef(remote: Remote, ref: string): Promise<string> {
  if (/^prd_[0-9A-HJKMNP-TV-Z]{26}$/.test(ref)) return ref
  for await (const page of remote.sdk.pages('listProducts', undefined, {} as never)) {
    const found = must(page).items.find((p) => p.slug === ref)
    if (found !== undefined) return found.id
  }
  throw new CliError('NOT_FOUND', `No product ${ref} is visible to you.`)
}

/** An environment reference (id or slug) within a product. */
async function environmentRef(remote: Remote, productId: string, ref: string): Promise<string> {
  if (/^env_[0-9A-HJKMNP-TV-Z]{26}$/.test(ref)) return ref
  for await (const page of remote.sdk.pages('listProductEnvironments', { productId }, {})) {
    const found = must(page).items.find((e) => e.slug === ref)
    if (found !== undefined) return found.id
  }
  throw new CliError('NOT_FOUND', `No environment ${ref} in this product is visible to you.`)
}

/** An environment (id or slug) of a project's product. */
async function projectEnvironmentRef(remote: Remote, projectId: string, ref: string) {
  if (/^env_[0-9A-HJKMNP-TV-Z]{26}$/.test(ref)) return ref
  const project = must(await remote.sdk.call('getProject', { params: { projectId } } as never)) as {
    readonly productId: string
  }
  return environmentRef(remote, project.productId, ref)
}

const ENVIRONMENT_FLAG = {
  name: 'environment',
  type: 'string',
  placeholder: 'env',
  description: "An environment of the project's product (id or slug).",
  required: true,
} as const

export const registryCommands: readonly CommandSpec[] = [
  // ----- products -----
  listCommand({
    path: ['product', 'list'],
    summary: 'List products.',
    group: 'registry',
    action: 'product.list',
    scopes: READ,
    output: 'ProductList',
    title: 'products',
    operation: 'listProducts',
    noun: 'product',
    columns: [{ title: 'PRODUCT' }, { title: 'SLUG' }, { title: 'NAME', flexible: true }],
    row: (p) => [p.id, p.slug, p.displayName],
  }),
  showCommand({
    path: ['product', 'show'],
    summary: 'Show a product.',
    group: 'registry',
    args: [{ name: 'product', description: 'A product id (prd_…) or slug.', required: true }],
    action: 'product.get',
    scopes: READ,
    output: 'Product',
    title: 'product',
    operation: 'getProduct',
    params: async (i, r) => ({ productId: await productRef(r, arg(i, 'product')) }),
    view: (p) => [
      {
        kind: 'fields',
        rows: [
          ['Product', p.id],
          ['Slug', p.slug],
          ['Name', p.displayName],
        ],
      },
    ],
    next: (p) => [`exponetdb environment list ${p.id}`],
  }),
  planCommand({
    path: ['product', 'create'],
    summary: 'Plan a new product.',
    group: 'registry',
    args: [
      {
        name: 'slug',
        description: 'Lowercase slug (the first segment of target paths).',
        required: true,
        body: true,
      },
    ],
    flags: [
      {
        name: 'name',
        type: 'string',
        placeholder: 'text',
        description: 'Display name.',
        required: true,
      },
    ],
    action: 'registry.product.create.plan',
    scopes: MANAGE,
    operation: 'planProduct',
    params: () => ({}),
    body: (i) => ({ slug: arg(i, 'slug'), displayName: flag(i, 'name') }),
  }),

  // ----- environments -----
  listCommand({
    path: ['environment', 'list'],
    summary: 'List the environments of a product, in rank order.',
    group: 'registry',
    args: [{ name: 'product', description: 'A product id or slug.', required: true }],
    action: 'environment.list',
    scopes: READ,
    output: 'EnvironmentList',
    title: 'environments',
    operation: 'listProductEnvironments',
    noun: 'environment',
    params: async (i, r) => ({ productId: await productRef(r, arg(i, 'product')) }),
    columns: [
      { title: 'ENVIRONMENT' },
      { title: 'SLUG' },
      { title: 'TIER' },
      { title: 'RANK', align: 'right' },
      { title: 'EVIDENCE FROM' },
    ],
    row: (e) => [e.id, e.slug, e.tier, String(e.rank), dash(e.evidenceFrom)],
  }),
  {
    path: ['environment', 'show'],
    summary: 'Show one environment of a product.',
    group: 'registry',
    args: [
      { name: 'product', description: 'A product id or slug.', required: true },
      { name: 'environment', description: 'An environment id (env_…) or slug.', required: true },
    ],
    locality: 'remote',
    effect: 'read',
    action: 'environment.list',
    scopes: READ,
    output: 'Environment',
    async run(ctx, input) {
      const remote = await ctx.remote()
      const wanted = arg(input, 'environment')
      let found: Environment | undefined
      for await (const page of remote.sdk.pages(
        'listProductEnvironments',
        { productId: await productRef(remote, arg(input, 'product')) },
        {},
      )) {
        const value = must(page)
        found = value.items.find((e) => e.id === wanted || e.slug === wanted)
        if (found !== undefined) break
      }
      if (found === undefined) {
        return result({
          command: 'environment show',
          status: 'error',
          exitCode: 1,
          error: {
            code: 'NOT_FOUND',
            message: `No environment ${wanted} in this product is visible to you.`,
          },
        })
      }
      const e = found
      return result({
        command: 'environment show',
        data: e,
        blocks: [
          header('environment', remote.context),
          {
            kind: 'fields',
            rows: [
              ['Environment', e.id],
              ['Slug', e.slug],
              ['Name', e.displayName],
              ['Tier', e.tier],
              ['Rank', String(e.rank)],
              ['Evidence from', e.evidenceFrom],
              ['Revision', String(e.revision)],
            ],
          },
        ],
      })
    },
  },
  planCommand({
    path: ['environment', 'create'],
    summary: 'Plan a new environment of a product.',
    group: 'registry',
    args: [
      { name: 'product', description: 'A product id or slug.', required: true },
      { name: 'slug', description: 'Lowercase slug.', required: true, body: true },
    ],
    flags: [
      {
        name: 'name',
        type: 'string',
        placeholder: 'text',
        description: 'Display name.',
        required: true,
      },
      {
        name: 'tier',
        type: 'enum',
        values: ['prod', 'nonprod'],
        description: 'The tier.',
        required: true,
      },
      { name: 'rank', type: 'number', description: 'Promotion order (lower first).' },
      {
        name: 'evidence-from',
        type: 'string',
        placeholder: 'env',
        description: 'The environment whose verified result production needs.',
      },
    ],
    action: 'registry.environment.create.plan',
    scopes: MANAGE,
    operation: 'planEnvironment',
    params: async (i, r) => ({ productId: await productRef(r, arg(i, 'product')) }),
    body: (i) => ({
      slug: arg(i, 'slug'),
      displayName: flag(i, 'name'),
      tier: tierOf(String(i.flags['tier'])),
      ...(typeof i.flags['rank'] === 'number' ? { rank: i.flags['rank'] } : {}),
      ...optional(i, 'evidence-from', (v) => v),
    }),
  }),
  planCommand({
    path: ['environment', 'update'],
    summary: 'Plan a change of an environment (name, tier, rank, evidence source).',
    group: 'registry',
    args: [
      { name: 'product', description: 'A product id or slug.', required: true },
      { name: 'environment', description: 'An environment id.', required: true },
    ],
    flags: [
      { name: 'name', type: 'string', placeholder: 'text', description: 'Display name.' },
      { name: 'tier', type: 'enum', values: ['prod', 'nonprod'], description: 'The tier.' },
      { name: 'rank', type: 'number', description: 'Promotion order.' },
      {
        name: 'evidence-from',
        type: 'string',
        placeholder: 'env',
        description: 'Evidence source environment.',
      },
      { name: 'no-evidence-from', type: 'boolean', description: 'Remove the evidence source.' },
    ],
    action: 'registry.environment.update.plan',
    scopes: MANAGE,
    operation: 'planEnvironmentChange',
    params: async (i, r) => {
      const productId = await productRef(r, arg(i, 'product'))
      return { productId, environmentId: await environmentRef(r, productId, arg(i, 'environment')) }
    },
    body: (i) => ({
      ...(i.flags['name'] === undefined ? {} : { displayName: flag(i, 'name') }),
      ...(i.flags['tier'] === undefined ? {} : { tier: tierOf(String(i.flags['tier'])) }),
      ...(typeof i.flags['rank'] === 'number' ? { rank: i.flags['rank'] } : {}),
      ...optional(i, 'evidence-from', (v) => v),
      ...(i.flags['no-evidence-from'] === true ? { evidenceFrom: null } : {}),
    }),
  }),

  // ----- projects -----
  listCommand({
    path: ['project', 'list'],
    summary: 'List projects.',
    group: 'registry',
    flags: [
      { name: 'product', type: 'string', placeholder: 'slug', description: 'Only this product.' },
    ],
    action: 'project.list',
    scopes: READ,
    output: 'ProjectList',
    title: 'projects',
    operation: 'listProjects',
    noun: 'project',
    query: (i) => optional(i, 'product', (v) => v),
    columns: [
      { title: 'PROJECT' },
      { title: 'PATH', flexible: true },
      { title: 'NAME', flexible: true },
      { title: 'REV', align: 'right' },
    ],
    row: (p) => [p.id, p.path, p.displayName, String(p.revision)],
  }),
  showCommand({
    path: ['project', 'show'],
    summary: 'Show a project and its managed scope.',
    group: 'registry',
    args: [{ name: 'project', description: 'A project id (prj_…).', required: true }],
    action: 'project.get',
    scopes: READ,
    output: 'Project',
    title: 'project',
    operation: 'getProject',
    params: (i) => ({ projectId: arg(i, 'project') }),
    view: (p) => [
      {
        kind: 'fields',
        rows: [
          ['Project', p.id],
          ['Path', p.path],
          ['Name', p.displayName],
          ['Product', p.productId],
          ['Revision', String(p.revision)],
          ['Managed scope', JSON.stringify(p.managedScope)],
        ],
      },
    ],
  }),
  planCommand({
    path: ['project', 'create'],
    summary: 'Plan a new project of a product.',
    group: 'registry',
    args: [
      { name: 'product', description: 'A product id or slug.', required: true, body: true },
      { name: 'slug', description: 'Lowercase slug.', required: true, body: true },
    ],
    flags: [
      {
        name: 'name',
        type: 'string',
        placeholder: 'text',
        description: 'Display name.',
        required: true,
      },
      {
        name: 'include-schemas',
        type: 'list',
        placeholder: 'a,b',
        description: 'Schemas the project manages.',
      },
      {
        name: 'exclude-schemas',
        type: 'list',
        placeholder: 'a,b',
        description: 'Schemas it never manages.',
      },
    ],
    action: 'registry.project.create.plan',
    scopes: MANAGE,
    operation: 'planProject',
    params: () => ({}),
    body: (i) => ({
      product: arg(i, 'product'),
      slug: arg(i, 'slug'),
      displayName: flag(i, 'name'),
      ...(i.flags['include-schemas'] === undefined && i.flags['exclude-schemas'] === undefined
        ? {}
        : {
            managedScope: {
              ...(i.flags['include-schemas'] === undefined
                ? {}
                : { includeSchemas: i.flags['include-schemas'] }),
              ...(i.flags['exclude-schemas'] === undefined
                ? {}
                : { excludeSchemas: i.flags['exclude-schemas'] }),
            },
          }),
    }),
  }),
  planCommand({
    path: ['project', 'update'],
    summary: 'Plan a project change (name, managed scope, execution roles, trusted extensions).',
    group: 'registry',
    args: [{ name: 'project', description: 'A project id.', required: true }],
    flags: [
      { name: 'name', type: 'string', placeholder: 'text', description: 'Display name.' },
      {
        name: 'execution-role',
        type: 'list',
        placeholder: 'name=role',
        description: 'Execution roles (name=PostgreSQL role).',
      },
      {
        name: 'trusted-extensions',
        type: 'list',
        placeholder: 'a,b',
        description: 'Extensions a bundle may require.',
      },
    ],
    action: 'registry.project.update.plan',
    scopes: MANAGE,
    operation: 'planProjectChange',
    params: (i) => ({ projectId: arg(i, 'project') }),
    body: (i) => ({
      ...(i.flags['name'] === undefined ? {} : { displayName: flag(i, 'name') }),
      ...(i.flags['execution-role'] === undefined
        ? {}
        : {
            executionRoles: Object.fromEntries(
              pairs(i.flags['execution-role'] as string[], 'execution-role'),
            ),
          }),
      ...(i.flags['trusted-extensions'] === undefined
        ? {}
        : { trustedExtensions: i.flags['trusted-extensions'] }),
    }),
  }),

  // ----- execution roles (ADR-0034) -----
  showCommand({
    path: ['project', 'execution-roles'],
    summary:
      "Show a project's execution roles: the default map, each environment's bindings and the declared exceptions.",
    group: 'registry',
    args: [{ name: 'project', description: 'A project id (prj_…).', required: true }],
    action: 'project.execution_roles.get',
    scopes: ['migrations.read'],
    output: 'ProjectExecutionRoles',
    title: 'execution roles',
    operation: 'getProjectExecutionRoles',
    params: (i) => ({ projectId: arg(i, 'project') }),
    view: (v) => [
      {
        kind: 'table',
        columns: [
          { title: 'ENVIRONMENT' },
          { title: 'TIER' },
          { title: 'ALIAS' },
          { title: 'ROLE', flexible: true },
          { title: 'SOURCE' },
        ],
        rows: v.environments.flatMap((e) =>
          Object.entries(e.effective).map(([alias, role]) => [
            e.slug,
            e.tier,
            alias,
            role,
            Object.hasOwn(e.bindings, alias) ? 'binding' : 'project',
          ]),
        ),
        empty: 'No execution roles: the project maps no alias.',
      },
      {
        kind: 'table',
        columns: [
          { title: 'EXCEPTION' },
          { title: 'ENVIRONMENT' },
          { title: 'ROLE' },
          { title: 'EXCUSES' },
          { title: 'STATE' },
          { title: 'REVIEW BY' },
        ],
        rows: v.exceptions.map((e) => [
          e.id,
          v.environments.find((x) => x.environmentId === e.environmentId)?.slug ?? e.environmentId,
          e.role,
          e.attributes.join(','),
          e.state === 'active' && e.expired ? 'expired' : e.state,
          dash(e.reviewBy),
        ]),
        empty: 'No declared exceptions.',
      },
    ],
  }),
  planCommand({
    path: ['project', 'execution-roles', 'set'],
    summary:
      "Plan one environment's execution roles (aliases of the project map bound to other roles); the set replaces the environment's bindings.",
    group: 'registry',
    args: [{ name: 'project', description: 'A project id.', required: true }],
    flags: [
      ENVIRONMENT_FLAG,
      {
        name: 'role',
        type: 'list',
        placeholder: 'alias=role',
        description: 'A binding (alias=PostgreSQL role); repeat for each alias.',
      },
      {
        name: 'clear',
        type: 'boolean',
        description: 'Remove every binding: the project map applies again.',
      },
    ],
    action: 'registry.execution_role_binding.set.plan',
    scopes: MANAGE,
    operation: 'planExecutionRoleBindings',
    params: async (i, r) => {
      const projectId = arg(i, 'project')
      return {
        projectId,
        environmentId: await projectEnvironmentRef(r, projectId, String(i.flags['environment'])),
      }
    },
    body: (i) => {
      const roles = i.flags['role'] as string[] | undefined
      if ((roles === undefined) === (i.flags['clear'] !== true)) {
        throw new UsageError('Give --role alias=role (repeatable) or --clear.')
      }
      return { roles: roles === undefined ? {} : Object.fromEntries(pairs(roles, 'role')) }
    },
  }),
  planCommand({
    path: ['project', 'role-exception', 'declare'],
    summary:
      'Plan a declared exception: one role may carry BYPASSRLS as an execution role of the project in one environment (nothing else is ever excused).',
    group: 'registry',
    args: [{ name: 'project', description: 'A project id.', required: true }],
    flags: [
      ENVIRONMENT_FLAG,
      {
        name: 'role',
        type: 'string',
        placeholder: 'role',
        description: 'The PostgreSQL role.',
        required: true,
      },
      {
        name: 'reason',
        type: 'string',
        placeholder: 'text',
        description: 'Why the role needs BYPASSRLS (20 to 1000 characters).',
        required: true,
      },
      {
        name: 'review-by',
        type: 'string',
        placeholder: 'YYYY-MM-DD',
        description: 'After this date the exception excuses nothing.',
      },
    ],
    action: 'registry.execution_role_exception.declare.plan',
    scopes: MANAGE,
    operation: 'planExecutionRoleException',
    params: async (i, r) => {
      const projectId = arg(i, 'project')
      return {
        projectId,
        environmentId: await projectEnvironmentRef(r, projectId, String(i.flags['environment'])),
      }
    },
    body: (i) => ({
      role: String(i.flags['role']),
      reason: String(i.flags['reason']),
      ...optional(i, 'review-by', (v) => v),
    }),
  }),
  planCommand({
    path: ['project', 'role-exception', 'revoke'],
    summary:
      'Plan the revocation of a declared exception; every plan that relied on it becomes stale.',
    group: 'registry',
    args: [
      { name: 'project', description: 'A project id.', required: true },
      { name: 'exception', description: 'The exception (rxe_…).', required: true },
    ],
    flags: [
      {
        name: 'reason',
        type: 'string',
        placeholder: 'text',
        description: 'Why it is revoked (up to 1000 characters).',
        required: true,
      },
    ],
    action: 'registry.execution_role_exception.revoke.plan',
    scopes: MANAGE,
    operation: 'planExecutionRoleExceptionRevocation',
    params: (i) => ({ projectId: arg(i, 'project'), exceptionId: arg(i, 'exception') }),
    body: (i) => ({ reason: String(i.flags['reason']) }),
  }),

  // ----- targets -----
  listCommand({
    path: ['target', 'list'],
    summary: 'List targets with tier, state and health.',
    group: 'registry',
    flags: [
      { name: 'product', type: 'string', placeholder: 'slug', description: 'Only this product.' },
      { name: 'project', type: 'string', placeholder: 'slug', description: 'Only this project.' },
      {
        name: 'environment',
        type: 'string',
        placeholder: 'slug',
        description: 'Only this environment.',
      },
      { name: 'tier', type: 'enum', values: ['prod', 'nonprod'], description: 'Only this tier.' },
      {
        name: 'state',
        type: 'string',
        placeholder: 'state',
        description: 'Only this lifecycle state.',
      },
    ],
    action: 'target.list',
    scopes: READ,
    output: 'TargetList',
    title: 'targets',
    operation: 'listTargets',
    noun: 'target',
    query: (i) => ({
      ...optional(i, 'product', (v) => v),
      ...optional(i, 'project', (v) => v),
      ...optional(i, 'environment', (v) => v),
      ...optional(i, 'tier', (v) => v),
      ...optional(i, 'state', (v) => v),
    }),
    columns: [
      { title: 'TARGET', flexible: true },
      { title: 'TIER' },
      { title: 'STATE' },
      { title: 'HEALTH' },
      { title: 'ID' },
    ],
    row: (t, now) => [t.path, t.tier, t.state, health(t.health, now), t.id],
  }),
  showCommand({
    path: ['target', 'show'],
    summary: 'Show a target: placement, ledger, health, findings.',
    group: 'registry',
    aliases: [['target', 'resolve']],
    args: [
      {
        name: 'target',
        description: 'A target id or path (product/project/environment).',
        required: true,
      },
    ],
    action: 'target.get',
    scopes: READ,
    output: 'Target',
    title: 'target',
    operation: 'getTarget',
    params: (i) => ({ target: arg(i, 'target') }),
    view: (t, now) => [
      {
        kind: 'fields',
        rows: [
          ['Target', t.path],
          ['Id', t.id],
          ['Tier', t.tier],
          ['State', t.state],
          ['Generation', String(t.generation)],
          ['Health', health(t.health, now)],
          [
            'Cluster',
            t.placement === null ? null : `${t.placement.clusterName} (${t.placement.clusterId})`,
          ],
          ['Server', t.placement?.serverName ?? null],
          ['PostgreSQL', t.placement?.postgresVersion ?? null],
          [
            'Ledger',
            t.ledger === null
              ? null
              : `${t.ledger.appliedCount} applied (${t.ledger.source}, ${ago(t.ledger.observedAt, now)})`,
          ],
          ['Open findings', String(t.openFindingCount)],
        ],
      },
    ],
    next: (t) => [`exponetdb migration status --target ${t.id}`, `exponetdb health ${t.id}`],
  }),
  planCommand({
    path: ['target', 'register'],
    summary: 'Plan registering a database of a cluster as a target of a project environment.',
    group: 'registry',
    flags: [
      {
        name: 'project',
        type: 'string',
        placeholder: 'prj_…',
        description: 'The project.',
        required: true,
      },
      {
        name: 'environment',
        type: 'string',
        placeholder: 'env_…',
        description: 'The environment.',
        required: true,
      },
      {
        name: 'database',
        type: 'string',
        placeholder: 'dbs_…',
        description: 'The registered database.',
        required: true,
      },
    ],
    action: 'target.register.plan',
    scopes: MANAGE,
    operation: 'planTargetRegistration',
    params: () => ({}),
    body: (i) => ({
      projectId: flag(i, 'project'),
      environmentId: flag(i, 'environment'),
      databaseId: flag(i, 'database'),
    }),
  }),
  ...(['suspend', 'resume', 'decommission'] as const).map((verb) =>
    planCommand({
      path: ['target', verb],
      summary: `Plan to ${verb} a target (with a reason).`,
      group: 'registry',
      args: [{ name: 'target', description: 'A target id or path.', required: true }],
      flags: [
        {
          name: 'reason',
          type: 'string',
          placeholder: 'text',
          description: 'Why (recorded with the plan).',
          required: true,
        },
      ],
      action: `target.${verb}.plan`,
      scopes: MANAGE,
      operation:
        verb === 'suspend'
          ? 'planTargetSuspension'
          : verb === 'resume'
            ? 'planTargetResumption'
            : 'planTargetDecommission',
      params: (i: CommandInput) => ({ target: arg(i, 'target') }),
      body: (i: CommandInput) => ({ reason: flag(i, 'reason') }),
      file: false,
    }),
  ),

  // ----- servers -----
  listCommand({
    path: ['server', 'list'],
    summary: 'List servers.',
    group: 'registry',
    action: 'server.list',
    scopes: NODES,
    output: 'ServerList',
    title: 'servers',
    operation: 'listServers',
    noun: 'server',
    columns: [
      { title: 'SERVER' },
      { title: 'NAME', flexible: true },
      { title: 'PROVIDER' },
      { title: 'TIER' },
      { title: 'LOCATION' },
    ],
    row: (s) => [s.id, s.displayName, s.provider, dash(s.derivedTier), dash(s.location)],
  }),
  showCommand({
    path: ['server', 'show'],
    summary: 'Show a server and the facts its node reported.',
    group: 'registry',
    args: [{ name: 'server', description: 'A server id (srv_…).', required: true }],
    action: 'server.get',
    scopes: NODES,
    output: 'Server',
    title: 'server',
    operation: 'getServer',
    params: (i) => ({ serverId: arg(i, 'server') }),
    view: (s, now) => [
      {
        kind: 'fields',
        rows: [
          ['Server', s.id],
          ['Name', s.displayName],
          ['Provider', s.provider],
          ['Location', s.location],
          ['Tier', s.derivedTier],
          [
            'OS',
            s.observedFacts === null ? null : `${s.observedFacts.os} (${s.observedFacts.kernel})`,
          ],
          ['CPUs', s.observedFacts === null ? null : String(s.observedFacts.cpus)],
          ['Reported', s.observedFacts === null ? null : ago(s.observedFacts.reportedAt, now)],
        ],
      },
    ],
    next: (s) => [`exponetdb node enrollment create ${s.id}`],
  }),
  planCommand({
    path: ['server', 'create'],
    summary: 'Plan a server record.',
    group: 'registry',
    args: [{ name: 'name', description: 'Display name.', required: true, body: true }],
    flags: [
      {
        name: 'provider',
        type: 'enum',
        values: SERVER_PROVIDERS,
        description: 'Where the server runs (a hosting provider, on_premises, other or unknown).',
        default: 'other',
      },
      {
        name: 'location',
        type: 'string',
        placeholder: 'text',
        description: 'Location (e.g. fsn1).',
      },
      {
        name: 'provider-ref',
        type: 'string',
        placeholder: 'id',
        description: 'The provider’s reference.',
      },
    ],
    action: 'registry.server.create.plan',
    scopes: MANAGE,
    operation: 'planServer',
    params: () => ({}),
    body: (i) => ({
      displayName: arg(i, 'name'),
      provider: String(i.flags['provider'] ?? 'other'),
      ...optional(i, 'location', (v) => v),
      ...optional(i, 'provider-ref', (v) => v),
    }),
  }),

  // ----- clusters -----
  listCommand({
    path: ['cluster', 'list'],
    summary: 'List clusters.',
    group: 'registry',
    action: 'cluster.list',
    scopes: NODES,
    output: 'ClusterList',
    title: 'clusters',
    operation: 'listClusters',
    noun: 'cluster',
    columns: [
      { title: 'CLUSTER' },
      { title: 'NAME', flexible: true },
      { title: 'STATE' },
      { title: 'MODE' },
      { title: 'POSTGRES' },
      { title: 'HEALTH' },
    ],
    row: (c, now) => [
      c.id,
      c.displayName,
      c.state,
      c.managementMode,
      dash(c.postgresVersion),
      health(c.health, now),
    ],
  }),
  showCommand({
    path: ['cluster', 'show'],
    summary: 'Show a cluster.',
    group: 'registry',
    args: [{ name: 'cluster', description: 'A cluster id (cls_…).', required: true }],
    action: 'cluster.get',
    scopes: NODES,
    output: 'Cluster',
    title: 'cluster',
    operation: 'getCluster',
    params: (i) => ({ clusterId: arg(i, 'cluster') }),
    view: (c, now) => [
      {
        kind: 'fields',
        rows: [
          ['Cluster', c.id],
          ['Name', c.displayName],
          ['State', c.state],
          ['Mode', c.managementMode],
          ['Server', c.serverId],
          ['PostgreSQL', c.postgresVersion],
          ['System id', c.systemIdentifier],
          ['Confirmed', c.confirmedAt],
          ['Tier', c.derivedTier],
          ['Health', health(c.health, now)],
        ],
      },
    ],
    next: (c) => [`exponetdb cluster endpoints ${c.id}`, `exponetdb cluster databases ${c.id}`],
  }),
  showCommand({
    path: ['cluster', 'endpoints'],
    summary: 'List the endpoints of a cluster.',
    group: 'registry',
    args: [{ name: 'cluster', description: 'A cluster id.', required: true }],
    action: 'endpoint.list',
    scopes: NODES,
    output: 'EndpointList',
    title: 'endpoints',
    operation: 'listClusterEndpoints',
    params: (i) => ({ clusterId: arg(i, 'cluster') }),
    view: (v) => [
      {
        kind: 'table',
        columns: [
          { title: 'ENDPOINT' },
          { title: 'LABEL' },
          { title: 'KIND' },
          { title: 'ADDRESS', flexible: true },
          { title: 'STATE' },
        ],
        rows: v.items.map((e) => [e.id, e.label, e.kind, `${e.host}:${e.port}`, e.state]),
        empty: 'No endpoints.',
      },
      ...(v.truncated
        ? [
            {
              kind: 'text' as const,
              tone: 'warn' as const,
              lines: ['The list is truncated by the server.'],
            },
          ]
        : []),
    ],
  }),
  showCommand({
    path: ['cluster', 'databases'],
    summary: 'List the registered databases of a cluster.',
    group: 'registry',
    args: [{ name: 'cluster', description: 'A cluster id.', required: true }],
    action: 'database.list',
    scopes: NODES,
    output: 'DatabaseList',
    title: 'databases',
    operation: 'listClusterDatabases',
    params: (i) => ({ clusterId: arg(i, 'cluster') }),
    view: (v) => [
      {
        kind: 'table',
        columns: [
          { title: 'DATABASE' },
          { title: 'NAME' },
          { title: 'STATE' },
          { title: 'TARGET' },
        ],
        rows: v.items.map((d) => [d.id, d.name, d.state, d.placement?.targetId ?? '-']),
        empty: 'No databases.',
      },
      ...(v.truncated
        ? [
            {
              kind: 'text' as const,
              tone: 'warn' as const,
              lines: ['The list is truncated by the server.'],
            },
          ]
        : []),
    ],
  }),
  showCommand({
    path: ['cluster', 'credentials'],
    summary: 'List credential metadata of a cluster (never a secret).',
    group: 'registry',
    args: [{ name: 'cluster', description: 'A cluster id.', required: true }],
    action: 'credential.list',
    scopes: NODES,
    output: 'CredentialList',
    title: 'credentials',
    operation: 'listClusterCredentials',
    params: (i) => ({ clusterId: arg(i, 'cluster') }),
    view: (v) => [
      {
        kind: 'table',
        columns: [
          { title: 'ROLE' },
          { title: 'PG ROLE' },
          { title: 'STATE' },
          { title: 'VERSION', align: 'right' },
          { title: 'VERIFIED' },
        ],
        rows: v.items.map((c) => [
          c.accessRole,
          c.roleName,
          c.state,
          String(c.version),
          dash(c.verifiedAt),
        ]),
        empty:
          'No credentials. Submit each with: exponetdb cluster credential submit <cluster> <role>',
      },
    ],
  }),
  {
    path: ['cluster', 'bootstrap-sql'],
    summary:
      'Write the cluster’s bootstrap SQL (roles, grants) to stdout or a new file, for a DBA to review and run.',
    description:
      'The SQL is the server’s, generated for this cluster; the CLI never runs it. Review it before a database administrator runs it by hand.',
    group: 'registry',
    args: [{ name: 'cluster', description: 'A cluster id.', required: true }],
    flags: [
      {
        name: 'file',
        type: 'string',
        placeholder: 'path',
        description: 'A new file to write (0600).',
      },
    ],
    locality: 'remote',
    effect: 'read',
    action: 'cluster.bootstrap_sql.get',
    scopes: MANAGE,
    output: 'ClusterBootstrapSql',
    async run(ctx, input) {
      const remote = await ctx.remote()
      const v = must(
        await remote.sdk.call('getClusterBootstrapSql', {
          params: { clusterId: arg(input, 'cluster') },
        }),
      )
      const file = flag(input, 'file')
      if (file !== undefined) {
        const { resolve } = await import('node:path')
        const { createNewPrivateFile } = await import('../files.ts')
        const path = resolve(ctx.io.cwd, file)
        await createNewPrivateFile(path, v.script.endsWith('\n') ? v.script : `${v.script}\n`)
        return result({
          command: 'cluster bootstrap-sql',
          data: { clusterId: v.clusterId, roles: v.roles, databases: v.databases, file: path },
          blocks: [
            {
              kind: 'text',
              lines: [`Bootstrap SQL written to ${path}. Review it; the CLI never runs it.`],
            },
          ],
        })
      }
      if (ctx.format === 'table') {
        // Plain SQL for a pipe or a file redirect, cleaned of terminal controls on a terminal.
        ctx.io.stdout(
          ctx.io.tty.stdout
            ? `${(await import('../output/text.ts')).clean(v.script)}\n`
            : `${v.script}\n`,
        )
        return result({ command: 'cluster bootstrap-sql' })
      }
      return result({ command: 'cluster bootstrap-sql', data: v })
    },
  },
  planCommand({
    path: ['cluster', 'register'],
    summary: 'Plan registering a PostgreSQL cluster (endpoints and CA bundle from --file).',
    description:
      'The request (display name, CA bundle, endpoints, optional server) comes from a JSON or YAML file checked against the contract; no password is part of it.',
    group: 'registry',
    action: 'registry.cluster.register.plan',
    scopes: MANAGE,
    operation: 'planClusterRegistration',
    params: () => ({}),
    body: () => {
      throw new UsageError(
        'Give the cluster as --file cluster.yaml (displayName, caBundle, endpoints, serverId).',
      )
    },
  }),
  planCommand({
    path: ['cluster', 'confirm'],
    summary: 'Plan confirming a cluster’s identity (its system identifier).',
    group: 'registry',
    args: [{ name: 'cluster', description: 'A cluster id.', required: true }],
    flags: [
      {
        name: 'system-identifier',
        type: 'string',
        placeholder: 'digits',
        description: 'The expected system identifier.',
      },
    ],
    action: 'registry.cluster.confirm.plan',
    scopes: MANAGE,
    operation: 'planClusterConfirmation',
    params: (i) => ({ clusterId: arg(i, 'cluster') }),
    body: (i) => optional(i, 'system-identifier', (v) => v),
    file: false,
  }),
  planCommand({
    path: ['cluster', 'endpoint', 'add'],
    summary: 'Plan a new endpoint of a cluster.',
    group: 'registry',
    args: [{ name: 'cluster', description: 'A cluster id.', required: true }],
    flags: [
      { name: 'label', type: 'string', placeholder: 'text', description: 'Label.', required: true },
      {
        name: 'kind',
        type: 'enum',
        values: ['private', 'public', 'local_socket', 'pooler'],
        description: 'Kind.',
        required: true,
      },
      {
        name: 'host',
        type: 'string',
        placeholder: 'host',
        description: 'Host name or address.',
        required: true,
      },
      { name: 'port', type: 'number', description: 'Port.', default: 5432 },
      {
        name: 'tls-server-name',
        type: 'string',
        placeholder: 'name',
        description: 'TLS server name to verify.',
      },
    ],
    action: 'registry.endpoint.add.plan',
    scopes: MANAGE,
    operation: 'planEndpoint',
    params: (i) => ({ clusterId: arg(i, 'cluster') }),
    body: (i) => ({
      label: flag(i, 'label'),
      kind: String(i.flags['kind']),
      host: flag(i, 'host'),
      port: Number(i.flags['port'] ?? 5432),
      ...optional(i, 'tls-server-name', (v) => v),
    }),
  }),
  planCommand({
    path: ['cluster', 'endpoint', 'retire'],
    summary: 'Plan retiring an endpoint.',
    group: 'registry',
    args: [
      { name: 'cluster', description: 'A cluster id.', required: true },
      { name: 'endpoint', description: 'An endpoint id.', required: true },
    ],
    flags: [{ name: 'reason', type: 'string', placeholder: 'text', description: 'Why.' }],
    action: 'registry.endpoint.retire.plan',
    scopes: MANAGE,
    operation: 'planEndpointRetirement',
    params: (i) => ({ clusterId: arg(i, 'cluster'), endpointId: arg(i, 'endpoint') }),
    body: (i) => optional(i, 'reason', (v) => v),
    file: false,
  }),
  planCommand({
    path: ['cluster', 'database', 'register'],
    summary: 'Plan registering a database of a cluster.',
    group: 'registry',
    args: [
      { name: 'cluster', description: 'A cluster id.', required: true },
      { name: 'name', description: 'The database name.', required: true },
    ],
    action: 'registry.database.register.plan',
    scopes: MANAGE,
    operation: 'planDatabaseRegistration',
    params: (i) => ({ clusterId: arg(i, 'cluster') }),
    body: (i) => ({ name: arg(i, 'name') }),
    file: false,
  }),
  {
    path: ['cluster', 'credential', 'submit'],
    summary:
      'Open the Web App’s write-only form for a role’s password, then wait until the worker verified it.',
    description:
      'The password a person set on an external cluster (psql \\password, or a verifier from exponetdb secrets scram-verifier) is entered once in the Web App with a fresh re-authentication; the CLI never reads or sends it (credentials-and-roles.md §5). The CLI opens the page for the cluster and role and, unless --no-wait, watches the credential until it is active or failed.',
    group: 'registry',
    args: [
      { name: 'cluster', description: 'A cluster id.', required: true },
      {
        name: 'role',
        description: 'observer, reader, verifier, operator or migrator.',
        required: true,
      },
    ],
    flags: WAIT_FLAGS,
    examples: ['exponetdb cluster credential submit cls_01J… observer'],
    locality: 'remote',
    effect: 'read',
    action: 'credential.list',
    scopes: NODES,
    output: 'CredentialView',
    async run(ctx, input) {
      const cluster = arg(input, 'cluster')
      const role = arg(input, 'role')
      if (!/^cls_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(cluster))
        throw new UsageError('The cluster is an id (cls_…).')
      if (!['observer', 'reader', 'verifier', 'operator', 'migrator'].includes(role)) {
        throw new UsageError('The role is observer, reader, verifier, operator or migrator.')
      }
      const remote = await ctx.remote()
      const latest = async () => {
        const v = must(
          await remote.sdk.call('listClusterCredentials', { params: { clusterId: cluster } }),
        )
        return v.items.filter((c) => c.accessRole === role).sort((a, b) => b.version - a.version)[0]
      }
      const before = await latest()
      const url = `${remote.server}/credentials#cluster=${cluster}&role=${role}`
      ctx.io.stderr(`Enter the ${role} password at: ${url}\n`)
      if (!ctx.global.noInput) ctx.io.openBrowser(url)
      const view = (c: NonNullable<typeof before>) => [
        header(`credential ${c.roleName} · ${cluster}`, remote.context),
        {
          kind: 'fields' as const,
          rows: [
            ['Version', String(c.version)],
            ['State', c.state],
            ['Submitted', c.submittedAt],
            ['Verified', c.verifiedAt],
            ['Failure', c.failureCode],
          ] as [string, string | null][],
        },
      ]
      if (!waits(input.flags) || ctx.global.noInput) {
        return result({
          command: 'cluster credential submit',
          status: 'requires_action',
          data: { url, current: before ?? null },
          blocks: [
            {
              kind: 'text',
              lines: [
                `Submit it at ${url}; the state shows in: exponetdb cluster credentials ${cluster}`,
              ],
            },
          ],
        })
      }
      const until = ctx.io.now() + Number(input.flags['timeout-wait'] ?? 900_000)
      for (;;) {
        const c = await latest()
        const fresh = c !== undefined && (before === undefined || c.version > before.version)
        if (fresh && c.state === 'active') {
          return result({ command: 'cluster credential submit', data: c, blocks: view(c) })
        }
        if (fresh && c.state === 'failed') {
          return result({
            command: 'cluster credential submit',
            status: 'failed',
            exitCode: EXIT.failure,
            data: c,
            blocks: view(c),
            error: {
              code: 'CREDENTIAL_FAILED',
              message: `The worker could not verify the ${role} password (${c.failureCode ?? 'unknown reason'}).`,
            },
          })
        }
        if (ctx.io.now() >= until) {
          return result({
            command: 'cluster credential submit',
            status: 'error',
            exitCode: EXIT.unresolved,
            data: c ?? null,
            error: {
              code: 'WATCH_TIMEOUT',
              message: `No verified ${role} password within the wait.`,
            },
          })
        }
        try {
          await ctx.io.sleep(2000, ctx.io.signal)
        } catch {
          return result({
            command: 'cluster credential submit',
            status: 'error',
            exitCode: EXIT.interrupted,
            error: { code: 'interrupted', message: 'Stopped waiting; the form stays valid.' },
          })
        }
      }
    },
  },
  planCommand({
    path: ['cluster', 'credential', 'rotate'],
    summary:
      'Plan rotating a cluster credential through the node (a new SCRAM verifier, set locally).',
    group: 'registry',
    args: [
      { name: 'cluster', description: 'A cluster id.', required: true },
      { name: 'role', description: 'The access role (e.g. observer, migrator).', required: true },
    ],
    action: 'credential.rotate.plan',
    scopes: ['nodes.plan'],
    operation: 'planCredentialRotation',
    params: (i) => ({ clusterId: arg(i, 'cluster'), role: arg(i, 'role') as never }),
    file: false,
  }),
]
