import { newId } from '@exponetdb/kernel'
import type { PlanRecord } from '@exponetdb/operations'
import { describe, expect, it } from 'vitest'
import {
  ControlPlaneSubjectResolver,
  planSubjectChain,
  type SubjectChain,
  type SubjectChainSource,
} from '../src/index.ts'

/**
 * Wave 4 subjects of the authorization engine (authorization.md §3, §5):
 * registry subjects resolve from the chain source (the registry), never
 * from a request; a plan keeps the tier recorded at planning time; a target
 * that a plan creates resolves through its path; a cluster's tier can only
 * rise; anything unknown is unresolved (deny).
 */
const P = newId('prd', 1)
const J = newId('prj', 2)
const E_STAGING = newId('env', 3)
const E_PROD = newId('env', 4)
const T = newId('tgt', 5)
const T_NEW = newId('tgt', 6)
const C_EMPTY = newId('cls', 7)
const C_PROD = newId('cls', 8)
const S = newId('srv', 9)

const source: SubjectChainSource = {
  async target(id) {
    return id === T
      ? { productId: P, projectId: J, environmentId: E_STAGING, targetId: T, tier: 'nonprod' }
      : undefined
  },
  async targetPath(path) {
    return path === 'acme/platform/production'
      ? { productId: P, projectId: J, environmentId: E_PROD, tier: 'prod' }
      : undefined
  },
  async product(id) {
    return id === P ? { productId: P } : undefined
  },
  async project(id) {
    return id === J ? { productId: P, projectId: J } : undefined
  },
  async environment(id) {
    if (id === E_STAGING) return { productId: P, environmentId: E_STAGING, tier: 'nonprod' }
    if (id === E_PROD) return { productId: P, environmentId: E_PROD, tier: 'prod' }
    return undefined
  },
  async cluster(id) {
    if (id === C_EMPTY) return {}
    if (id === C_PROD) return { tier: 'prod' }
    return undefined
  },
  async server(id) {
    return id === S ? {} : undefined
  },
}

const resolver = new ControlPlaneSubjectResolver(source)
const plan = (subject: Record<string, unknown>) =>
  resolver.resolve({ kind: 'plan', subject: subject as never })

describe('registry subjects', () => {
  it('resolves each registry subject from the source and refuses an unknown one', async () => {
    expect(await resolver.resolve({ kind: 'product', productId: P })).toEqual({ productId: P })
    expect(await resolver.resolve({ kind: 'project', projectId: J })).toEqual({
      productId: P,
      projectId: J,
    })
    expect(await resolver.resolve({ kind: 'environment', environmentId: E_PROD })).toMatchObject({
      tier: 'prod',
    })
    expect(await resolver.resolve({ kind: 'cluster', clusterId: C_EMPTY })).toEqual({})
    expect(await resolver.resolve({ kind: 'server', serverId: S })).toEqual({})
    expect(await resolver.resolve({ kind: 'product', productId: newId('prd', 99) })).toBeUndefined()
    expect(await resolver.resolve({ kind: 'target', targetId: T_NEW })).toBeUndefined()
  })

  it('refuses every registry subject without a source (Wave 3A composition)', async () => {
    const none = new ControlPlaneSubjectResolver()
    expect(await none.resolve({ kind: 'product', productId: P })).toBeUndefined()
    expect(await none.resolve({ kind: 'cluster', clusterId: C_PROD })).toBeUndefined()
    expect(await none.resolve({ kind: 'plan', subject: { environmentId: E_PROD } })).toBeUndefined()
    expect(await none.resolve({ kind: 'installation' })).toEqual({})
  })
})

describe('plan subjects', () => {
  it('resolves a target registration through the path of the target it creates', async () => {
    expect(
      await plan({ targetId: T_NEW, targetPath: 'acme/platform/production', tier: 'prod' }),
    ).toEqual({ productId: P, projectId: J, environmentId: E_PROD, targetId: T_NEW, tier: 'prod' })
    // A recorded tier the registry no longer agrees with refuses.
    expect(
      await plan({ targetId: T_NEW, targetPath: 'acme/platform/production', tier: 'nonprod' }),
    ).toBeUndefined()
    expect(await plan({ targetId: T_NEW, targetPath: 'acme/platform/unknown' })).toBeUndefined()
  })

  it('resolves a target path before the target exists (planning its registration)', async () => {
    expect(await plan({ targetPath: 'acme/platform/production', tier: 'prod' })).toEqual({
      productId: P,
      projectId: J,
      environmentId: E_PROD,
      tier: 'prod',
    })
    expect(await plan({ targetPath: 'acme/platform/production', tier: 'nonprod' })).toBeUndefined()
  })

  it('resolves a registered target and refuses a tier that changed', async () => {
    expect(await plan({ targetId: T, tier: 'nonprod' })).toMatchObject({ targetId: T })
    expect(await plan({ targetId: T, tier: 'prod' })).toBeUndefined()
  })

  it('keeps the tier a new environment records on its product chain', async () => {
    expect(await plan({ productId: P, tier: 'prod' })).toEqual({ productId: P, tier: 'prod' })
    expect(await plan({ productId: P })).toEqual({ productId: P })
    expect(await plan({ productId: newId('prd', 98), tier: 'prod' })).toBeUndefined()
  })

  it('resolves an environment change against the environment as it is', async () => {
    expect(await plan({ productId: P, environmentId: E_PROD, tier: 'prod' })).toMatchObject({
      environmentId: E_PROD,
      tier: 'prod',
    })
    expect(await plan({ productId: P, environmentId: E_PROD, tier: 'nonprod' })).toBeUndefined()
  })

  it('takes the stricter tier of a cluster: the recorded one or the derived one now', async () => {
    expect(await plan({ clusterId: C_EMPTY })).toEqual({})
    expect(await plan({ clusterId: C_EMPTY, tier: 'nonprod' })).toEqual({ tier: 'nonprod' })
    // A production target arrived on the cluster after planning: production governs.
    expect(await plan({ clusterId: C_PROD, tier: 'nonprod' })).toEqual({ tier: 'prod' })
    // A cluster the plan registers: only global bindings cover it.
    expect(await plan({ clusterId: newId('cls', 97) })).toEqual({})
    expect(
      await new ControlPlaneSubjectResolver().resolve({
        kind: 'plan',
        subject: { clusterId: C_EMPTY },
      }),
    ).toBeUndefined()
  })

  it('treats a plan without a registry subject as installation-wide', async () => {
    expect(await plan({})).toEqual({})
    expect(await plan({ tier: 'prod' })).toEqual({ tier: 'prod' })
  })
})

describe('approval coverage chain', () => {
  const record = (subject: unknown): PlanRecord => ({ body: { subject } }) as unknown as PlanRecord

  it('is the subject recorded at planning time', () => {
    const chain: SubjectChain | undefined = planSubjectChain(
      record({
        targetId: T_NEW,
        targetPath: 'acme/platform/production',
        tier: 'prod',
        productId: P,
        projectId: J,
        environmentId: E_PROD,
        clusterId: C_PROD,
        generation: 1,
      }),
    )
    expect(chain).toEqual({
      productId: P,
      projectId: J,
      environmentId: E_PROD,
      targetId: T_NEW,
      tier: 'prod',
    })
    expect(planSubjectChain(record({}))).toEqual({})
  })

  it('is undefined (no approval counts) for a malformed subject', () => {
    expect(planSubjectChain(record({ tier: 'staging' }))).toBeUndefined()
    expect(planSubjectChain(record({ targetId: 42 }))).toBeUndefined()
    expect(planSubjectChain(record('installation'))).toBeUndefined()
  })
})
