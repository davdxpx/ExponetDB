import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeApi, ok, ulid } from './fake-api.ts'

/**
 * TC-052: a project is named by its path wherever a target, a migration or a health read accept
 * one. `project execution-roles reosa/platform` answered `VALIDATION_FAILED /projectId: Expected
 * the prefix prj_`; the CLI resolves the path with one read of the product's projects.
 */
let api: FakeApi
const PRJ = ulid('prj', 1)

beforeEach(async () => {
  api = new FakeApi()
  await api.open()
  api.on('GET', '/projects', () =>
    ok('listProjects', {
      items: [
        {
          id: PRJ,
          productId: ulid('prd', 2),
          slug: 'platform',
          path: 'reosa/platform',
          displayName: 'Platform',
          evidenceOverride: {},
          managedScope: { includeSchemas: null, excludeSchemas: [] },
          revision: 1,
        },
      ],
      nextCursor: null,
    }),
  )
  api.on(
    'GET',
    `/projects/${PRJ}/execution-roles`,
    ok('getProjectExecutionRoles', {
      projectId: PRJ,
      defaults: { app: 'app_rw' },
      environments: [],
      exceptions: [],
    }),
  )
})

afterEach(() => api.close())

describe('a project path (TC-052)', () => {
  it('resolves product/project to the id with one read of the product’s projects', async () => {
    const r = await api.cli(['project', 'execution-roles', 'reosa/platform', '--output', 'json'])
    expect(r.code, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout).data.projectId).toBe(PRJ)
    const listing = api.requests.find((q) => q.path === '/projects')
    expect(listing?.query.get('product')).toBe('reosa')
  })

  it('still takes the id without any lookup', async () => {
    const r = await api.cli(['project', 'execution-roles', PRJ, '--output', 'json'])
    expect(r.code, r.stderr).toBe(0)
    expect(api.requests.some((q) => q.path === '/projects')).toBe(false)
  })

  it('says which project it did not find', async () => {
    const r = await api.cli(['project', 'execution-roles', 'reosa/nothing'])
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('reosa/nothing')
  })
})

/**
 * TC-065: `migration import scratch-reset-sql --scratch reosa/platform/staging` printed a full in-place
 * reset script for the staging target: it checked only that the tier was nonprod. A script that
 * resets a database is offered for a scratch environment only.
 */
describe('scratch-reset-sql (TC-065)', () => {
  const target = (slug: string) => {
    const n = slug === 'scratch' ? 3 : 4
    return ok('getTarget', {
      id: ulid('tgt', n),
      path: `reosa/platform/${slug}`,
      productId: ulid('prd', 2),
      projectId: PRJ,
      environmentId: ulid('env', n),
      tier: 'nonprod',
      state: 'active',
      generation: 1,
      health: null,
      environment: { slug, tier: 'nonprod' },
      placement: null,
      ledger: null,
      openFindingCount: 0,
      mode: 'managed',
    })
  }

  beforeEach(() => {
    api.on(
      'GET',
      `/projects/${PRJ}`,
      ok('getProject', {
        id: PRJ,
        productId: ulid('prd', 2),
        slug: 'platform',
        path: 'reosa/platform',
        displayName: 'Platform',
        evidenceOverride: {},
        managedScope: { includeSchemas: null, excludeSchemas: [] },
        revision: 1,
      }),
    )
  })

  it('refuses a target whose environment is not a scratch environment, and prints no script', async () => {
    api.on('GET', `/targets/${encodeURIComponent('reosa/platform/staging')}`, target('staging'))
    const r = await api.cli([
      'migration',
      'import',
      'scratch-reset-sql',
      '--scratch',
      'reosa/platform/staging',
    ])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('staging')
    expect(r.stdout).not.toMatch(/DROP|TRUNCATE|CREATE SCHEMA/i)
  })

  it('still offers the script for a scratch environment', async () => {
    api.on('GET', `/targets/${encodeURIComponent('reosa/platform/scratch')}`, target('scratch'))
    const r = await api.cli([
      'migration',
      'import',
      'scratch-reset-sql',
      '--scratch',
      'reosa/platform/scratch',
    ])
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain('CREATE SCHEMA')
  })
})
