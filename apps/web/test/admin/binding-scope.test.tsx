import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import type { ResponseOf } from '../../src/lib/api/client.ts'
import { binding, environment, identity } from './fixtures.ts'
import {
  BIDI,
  expectInert,
  HOSTILE,
  mountApp,
  OTHER,
  PLAN,
  plan,
  problem,
  World,
} from './support.tsx'

afterEach(cleanup)

type Product = ResponseOf<'listProducts'>['items'][number]
type Project = ResponseOf<'listProjects'>['items'][number]
type Target = ResponseOf<'listTargets'>['items'][number]

const PRD = 'prd_01JZ0000000000000000000001'
const PRJ = 'prj_01JZ0000000000000000000001'
const ENV_STAGING = 'env_01JZ0000000000000000000001'
const ENV_PROD = 'env_01JZ0000000000000000000002'
const TGT_PROD = 'tgt_01JZ0000000000000000000011'
const TGT_STAGING = 'tgt_01JZ0000000000000000000012'

const product = (over: Partial<Product> = {}): Product => ({
  id: PRD,
  slug: 'shop',
  displayName: 'Shop',
  ...over,
})

const project = (over: Partial<Project> = {}): Project => ({
  id: PRJ,
  productId: PRD,
  slug: 'app',
  path: 'shop/app',
  displayName: 'App',
  evidenceOverride: {},
  managedScope: { includeSchemas: null, excludeSchemas: [] },
  revision: 1,
  ...over,
})

const target = (over: Partial<Target> = {}): Target => ({
  environmentId: ENV_PROD,
  generation: 1,
  health: null,
  id: TGT_PROD,
  path: 'shop/app/production',
  productId: PRD,
  projectId: PRJ,
  state: 'active',
  tier: 'prod',
  ...over,
})

const ROLES = {
  items: [
    {
      builtIn: true,
      id: 'viewer',
      intendedFor: 'People who read and never change.',
      permissions: ['targets.read'],
      title: 'Viewer',
    },
    {
      builtIn: true,
      id: 'developer',
      intendedFor: 'People who plan migrations.',
      permissions: ['targets.read', 'migrations.plan'],
      title: 'Developer',
    },
  ],
}

const ENVIRONMENTS = {
  items: [
    environment({ id: ENV_STAGING, slug: 'staging', displayName: 'Staging', tier: 'nonprod' }),
    environment({
      id: ENV_PROD,
      slug: 'production',
      displayName: 'Production',
      tier: 'prod',
      rank: 20,
    }),
  ],
  nextCursor: null,
}

function registryWorld(): World {
  const world = new World()
  world.on('GET', '/api/v1/identities', { items: [identity()], nextCursor: null })
  world.on('GET', '/api/v1/role-bindings', { items: [binding()], nextCursor: null })
  world.on('GET', '/api/v1/roles', ROLES)
  world.on('GET', '/api/v1/products', { items: [product()], nextCursor: null })
  world.on('GET', '/api/v1/projects', { items: [project()], nextCursor: null })
  world.on('GET', `/api/v1/products/${PRD}/environments`, ENVIRONMENTS)
  world.on('GET', '/api/v1/targets', {
    items: [target(), target({ id: TGT_STAGING, path: 'shop/app/staging', tier: 'nonprod' })],
    nextCursor: null,
  })
  return world
}

function card(): HTMLElement {
  const found = document.querySelector<HTMLElement>(`li[data-identity="${OTHER}"]`)
  if (found === null) throw new Error('no card')
  return found
}

async function form(): Promise<HTMLElement> {
  await waitFor(() => expect(card()).toBeInTheDocument())
  return within(card()).getByRole('form', { name: 'Plan a role binding' })
}

describe('the role of a binding', () => {
  it('shows what the role catalog says the role is for, and follows the choice', async () => {
    const user = userEvent.setup()
    const world = registryWorld()
    const { container } = mountApp('/access/people', world)
    const f = await form()
    expect(await within(f).findByText('People who read and never change.')).toBeInTheDocument()
    await user.selectOptions(within(f).getByLabelText('Role'), 'developer')
    expect(within(f).getByText('People who plan migrations.')).toBeInTheDocument()
    expect(within(f).queryByText('People who read and never change.')).toBeNull()
    // The description is what the select is described by.
    const select = within(f).getByLabelText('Role')
    const describedBy = select.getAttribute('aria-describedby') ?? ''
    expect(document.getElementById(describedBy)).toHaveTextContent('People who plan migrations.')
    expect(await axeViolations(container)).toEqual([])
  })

  it('says when the catalog has no description for the role and when it could not be read', async () => {
    const user = userEvent.setup()
    const world = registryWorld()
    world.on('GET', '/api/v1/roles', { items: [ROLES.items[1]] })
    mountApp('/access/people', world)
    const f = await form()
    expect(
      await within(f).findByText('The role catalog has no description for this role.'),
    ).toBeInTheDocument()
    await user.selectOptions(within(f).getByLabelText('Role'), 'developer')
    expect(within(f).getByText('People who plan migrations.')).toBeInTheDocument()
    cleanup()

    const failing = registryWorld()
    failing.on('GET', '/api/v1/roles', () => problem(500, 'INTERNAL', 'The server failed.'))
    mountApp('/access/people', failing)
    expect(
      await within(await form()).findByText('The role description could not be read.'),
    ).toBeInTheDocument()
  })
})

describe('the scope of a binding, chosen by name', () => {
  it('offers the installation with a note that it includes production', async () => {
    const world = registryWorld()
    mountApp('/access/people', world)
    const f = await form()
    expect(within(f).getByText('This scope includes production.')).toBeInTheDocument()
    expect(f.querySelector('[data-tier="production"]')).not.toBeNull()
    // No registry read is made for a scope that names nothing.
    expect(world.reads('/api/v1/products')).toHaveLength(0)
    expect(world.reads('/api/v1/targets')).toHaveLength(0)
  })

  it('picks a product by name, fills its ID and notes that it includes production', async () => {
    const user = userEvent.setup()
    const world = registryWorld()
    world.on('POST', '/api/v1/role-bindings', (request) => {
      expect(request.body).toEqual({
        identityId: OTHER,
        roleId: 'viewer',
        scope: { kind: 'product', productId: PRD },
      })
      return { status: 201, json: plan() }
    })
    const { router, container } = mountApp('/access/people', world)
    const f = await form()
    await user.selectOptions(within(f).getByLabelText('Applies to'), 'product')
    expect(await within(f).findByRole('option', { name: 'Shop (shop)' })).toBeInTheDocument()
    await user.selectOptions(within(f).getByLabelText('Product'), PRD)
    expect(within(f).getByLabelText('Product ID')).toHaveValue(PRD)
    // The product's environments say whether it reaches production.
    expect(await within(f).findByText('This scope includes production.')).toBeInTheDocument()
    expect(await axeViolations(container)).toEqual([])
    await user.click(within(f).getByRole('button', { name: 'Create plan to bind role' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
  })

  it('notes a non-production only product from its environments', async () => {
    const user = userEvent.setup()
    const world = registryWorld()
    world.on('GET', `/api/v1/products/${PRD}/environments`, {
      items: [ENVIRONMENTS.items[0]],
      nextCursor: null,
    })
    mountApp('/access/people', world)
    const f = await form()
    await user.selectOptions(within(f).getByLabelText('Applies to'), 'product')
    await user.selectOptions(await within(f).findByLabelText('Product'), PRD)
    expect(await within(f).findByText('This scope covers non-production only.')).toBeInTheDocument()
    expect(f.querySelector('[data-tier="nonprod"]')).not.toBeNull()
    expect(f.querySelector('[data-tier="production"]')).toBeNull()
  })

  it('says a product’s tier is not known while its environments are missing or could not be read', async () => {
    const user = userEvent.setup()
    const world = registryWorld()
    world.on('GET', `/api/v1/products/${PRD}/environments`, () =>
      problem(500, 'INTERNAL', 'The server failed.'),
    )
    mountApp('/access/people', world)
    const f = await form()
    await user.selectOptions(within(f).getByLabelText('Applies to'), 'product')
    await user.selectOptions(await within(f).findByLabelText('Product'), PRD)
    expect(
      await within(f).findByText('Whether this scope includes production is not known.'),
    ).toBeInTheDocument()
    // Unknown is never shown as non-production.
    expect(within(f).queryByText('This scope covers non-production only.')).toBeNull()
    expect(f.querySelector('[data-tier="nonprod"]')).toBeNull()
  })

  it('picks a project by its path and takes its production cover from its product', async () => {
    const user = userEvent.setup()
    const world = registryWorld()
    world.on('POST', '/api/v1/role-bindings', (request) => {
      expect(request.body).toMatchObject({ scope: { kind: 'project', projectId: PRJ } })
      return { status: 201, json: plan() }
    })
    const { router } = mountApp('/access/people', world)
    const f = await form()
    await user.selectOptions(within(f).getByLabelText('Applies to'), 'project')
    expect(await within(f).findByRole('option', { name: 'shop/app' })).toBeInTheDocument()
    await user.selectOptions(within(f).getByLabelText('Project'), PRJ)
    expect(within(f).getByLabelText('Project ID')).toHaveValue(PRJ)
    expect(await within(f).findByText('This scope includes production.')).toBeInTheDocument()
    await user.click(within(f).getByRole('button', { name: 'Create plan to bind role' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
  })

  it('picks an environment of a product with its tier in the option and a chip below', async () => {
    const user = userEvent.setup()
    const world = registryWorld()
    world.on('POST', '/api/v1/role-bindings', (request) => {
      expect(request.body).toMatchObject({
        scope: { kind: 'environment', environmentId: ENV_STAGING },
      })
      return { status: 201, json: plan() }
    })
    const { router } = mountApp('/access/people', world)
    const f = await form()
    await user.selectOptions(within(f).getByLabelText('Applies to'), 'environment')
    // Environments belong to a product: it is chosen first.
    expect(within(f).getByText('Choose a product to list its environments.')).toBeInTheDocument()
    expect(within(f).queryByLabelText('Environment')).toBeNull()
    await user.selectOptions(await within(f).findByLabelText('Product of the environment'), PRD)
    expect(
      await within(f).findByRole('option', { name: 'Staging (staging, Non-production)' }),
    ).toBeInTheDocument()
    expect(
      within(f).getByRole('option', { name: 'Production (production, Production)' }),
    ).toBeInTheDocument()
    await user.selectOptions(within(f).getByLabelText('Environment'), ENV_PROD)
    expect(within(f).getByText('This scope includes production.')).toBeInTheDocument()
    await user.selectOptions(within(f).getByLabelText('Environment'), ENV_STAGING)
    expect(within(f).getByLabelText('Environment ID')).toHaveValue(ENV_STAGING)
    expect(within(f).getByText('This scope covers non-production only.')).toBeInTheDocument()
    await user.click(within(f).getByRole('button', { name: 'Create plan to bind role' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
  })

  it('picks a target by its path and shows its own tier', async () => {
    const user = userEvent.setup()
    const world = registryWorld()
    mountApp('/access/people', world)
    const f = await form()
    await user.selectOptions(within(f).getByLabelText('Applies to'), 'target')
    expect(
      await within(f).findByRole('option', { name: 'shop/app/production (Production)' }),
    ).toBeInTheDocument()
    await user.selectOptions(within(f).getByLabelText('Target'), TGT_STAGING)
    expect(within(f).getByLabelText('Target ID')).toHaveValue(TGT_STAGING)
    expect(within(f).getByText('This scope covers non-production only.')).toBeInTheDocument()
    await user.selectOptions(within(f).getByLabelText('Target'), TGT_PROD)
    expect(within(f).getByText('This scope includes production.')).toBeInTheDocument()
  })

  it('keeps the typed ID as the value: a typed ID fills the choice and is checked as before', async () => {
    const user = userEvent.setup()
    const world = registryWorld()
    mountApp('/access/people', world)
    const f = await form()
    await user.selectOptions(within(f).getByLabelText('Applies to'), 'target')
    await within(f).findByRole('option', { name: 'shop/app/production (Production)' })
    fireEvent.change(within(f).getByLabelText('Target ID'), { target: { value: TGT_PROD } })
    expect(within(f).getByLabelText('Target')).toHaveValue(TGT_PROD)
    fireEvent.change(within(f).getByLabelText('Target ID'), { target: { value: 'tgt_bad' } })
    await user.click(within(f).getByRole('button', { name: 'Create plan to bind role' }))
    expect(await within(f).findByText(/starts with tgt_ followed by 26/)).toBeInTheDocument()
    expect(world.changes).toEqual([])
    // An ID that is not listed has no tier the page can name.
    fireEvent.change(within(f).getByLabelText('Target ID'), {
      target: { value: 'tgt_01JZ0000000000000000000099' },
    })
    expect(within(f).getByLabelText('Target')).toHaveValue('')
    expect(
      within(f).getByText('Whether this scope includes production is not known.'),
    ).toBeInTheDocument()
  })

  it('does not carry an ID over to another kind of scope', async () => {
    const user = userEvent.setup()
    const world = registryWorld()
    mountApp('/access/people', world)
    const f = await form()
    await user.selectOptions(within(f).getByLabelText('Applies to'), 'target')
    await within(f).findByRole('option', { name: 'shop/app/production (Production)' })
    await user.selectOptions(within(f).getByLabelText('Target'), TGT_PROD)
    await user.selectOptions(within(f).getByLabelText('Applies to'), 'product')
    expect(within(f).getByLabelText('Product ID')).toHaveValue('')
    await user.selectOptions(within(f).getByLabelText('Applies to'), 'global')
    expect(within(f).queryByLabelText('Product ID')).toBeNull()
  })

  it('says a failed list read failed, keeps the field for the ID and still plans with it', async () => {
    const user = userEvent.setup()
    const world = registryWorld()
    world.on('GET', '/api/v1/products', () => problem(500, 'INTERNAL', 'The server failed.'))
    world.on('POST', '/api/v1/role-bindings', (request) => {
      expect(request.body).toMatchObject({ scope: { kind: 'product', productId: PRD } })
      return { status: 201, json: plan() }
    })
    const { router } = mountApp('/access/people', world)
    const f = await form()
    await user.selectOptions(within(f).getByLabelText('Applies to'), 'product')
    expect(await within(f).findByText(/Could not read Product list/)).toBeInTheDocument()
    expect(within(f).queryByText(/The read succeeded/)).toBeNull()
    fireEvent.change(within(f).getByLabelText('Product ID'), { target: { value: PRD } })
    await user.click(within(f).getByRole('button', { name: 'Create plan to bind role' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
  })

  it('says a cut or empty or refused list as it is', async () => {
    const user = userEvent.setup()
    const world = registryWorld()
    world.on('GET', '/api/v1/products', { items: [product()], nextCursor: 'more' })
    world.on('GET', '/api/v1/projects', { items: [], nextCursor: null })
    world.on('GET', '/api/v1/targets', () => problem(403, 'PERMISSION_DENIED', 'Not permitted.'))
    mountApp('/access/people', world)
    const f = await form()
    await user.selectOptions(within(f).getByLabelText('Applies to'), 'product')
    expect(await within(f).findByText(/Only the first 200 are listed/)).toBeInTheDocument()
    await user.selectOptions(within(f).getByLabelText('Applies to'), 'project')
    expect(
      await within(f).findByText(/The read succeeded and Project list is empty/),
    ).toBeInTheDocument()
    await user.selectOptions(within(f).getByLabelText('Applies to'), 'target')
    expect(await within(f).findByText(/You do not have access to Target list/)).toBeInTheDocument()
  })

  it('shows hostile names as plain text with hidden characters named', async () => {
    const user = userEvent.setup()
    const world = registryWorld()
    world.on('GET', '/api/v1/products', {
      items: [product({ displayName: `${BIDI}${HOSTILE}` })],
      nextCursor: null,
    })
    const { container } = mountApp('/access/people', world)
    const f = await form()
    await user.selectOptions(within(f).getByLabelText('Applies to'), 'product')
    const option = await waitFor(() => {
      const found = f.querySelector(`option[value="${PRD}"]`)
      if (found === null) throw new Error('no option yet')
      return found
    })
    expect(option.textContent).toContain('⟨U+202E⟩')
    expect(option.textContent).toContain('<script>')
    expectInert(container)
  })
})
