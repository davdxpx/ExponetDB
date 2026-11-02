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
