import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { BIDI, CLUSTER, mountApp, PLAN, World } from '../fleet/support.tsx'

afterEach(cleanup)

const PRODUCT = 'prd_01M4S9000000000000000000P1'
const PROJECT = 'prj_01M4S9000000000000000000J1'
const STAGING = 'env_01M4S9000000000000000000E1'
const PRODUCTION = 'env_01M4S9000000000000000000E2'
const DATABASE = 'dbs_01M4S9000000000000000000D1'

async function choose(label: string, value: string): Promise<void> {
  const select = await screen.findByLabelText(label)
  await waitFor(() => expect(select).not.toBeDisabled())
  fireEvent.change(select, { target: { value } })
}

async function fillAll(environment = STAGING): Promise<void> {
  await choose('Product', PRODUCT)
  await choose('Project', PROJECT)
  await choose('Environment', environment)
  await choose('Cluster', CLUSTER)
  await choose('Database', DATABASE)
}

describe('the register target page', () => {
  it('offers each choice only after the one it depends on', async () => {
    const world = new World()
    mountApp('/targets/register', world)
    expect(await screen.findByLabelText('Project')).toBeDisabled()
    expect(screen.getByLabelText('Environment')).toBeDisabled()
    expect(screen.getByLabelText('Database')).toBeDisabled()
    expect(world.gets('/environments')).toHaveLength(0)
    await choose('Product', PRODUCT)
    await choose('Project', PROJECT)
    const environment = await screen.findByLabelText('Environment')
    await waitFor(() => expect(within(environment).getAllByRole('option')).toHaveLength(3))
    await choose('Cluster', CLUSTER)
    // Only a database that is registered and placed nowhere can be chosen.
    const database = await screen.findByLabelText('Database')
    await waitFor(() => expect(within(database).getAllByRole('option')).toHaveLength(2))
    expect(within(database).getByRole('option', { name: 'orders' })).toBeInTheDocument()
    expect(within(database).queryByRole('option', { name: 'taken' })).toBeNull()
  })

  it('shows the declared tier of the cluster, and says what an undeclared one means', async () => {
    const world = new World()
    mountApp('/targets/register', world)
    await choose('Cluster', CLUSTER)
    expect(await screen.findByText('This cluster is declared non-production.')).toBeInTheDocument()
    cleanup()
    const prod = new World()
    prod.clusters = [{ ...prod.firstCluster(), declaredTier: 'prod' }]
    mountApp('/targets/register', prod)
    await choose('Cluster', CLUSTER)
    expect(await screen.findByText('This cluster is declared production.')).toBeInTheDocument()
    cleanup()
    const undeclared = new World()
    undeclared.clusters = [{ ...undeclared.firstCluster(), declaredTier: null }]
    mountApp('/targets/register', undeclared)
    await choose('Cluster', CLUSTER)
    expect(
      await screen.findByText(/no declared tier\. It is treated as production/),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/needs production authority to register, whatever the environment says/),
    ).toBeInTheDocument()
  })

  it('links the credentials page and the infrastructure page from the cluster choice', async () => {
    mountApp('/targets/register', new World())
    await choose('Cluster', CLUSTER)
    expect(await screen.findByRole('link', { name: 'Open the credentials page' })).toHaveAttribute(
      'href',
      `/credentials#cluster=${CLUSTER}`,
    )
    expect(screen.getByRole('link', { name: 'Declare a cluster tier' })).toHaveAttribute(
      'href',
      '/infrastructure/clusters',
    )
  })

  it('summarizes the target and shows the production cue for a production environment', async () => {
    mountApp('/targets/register', new World())
    await fillAll(PRODUCTION)
    const summary = (await screen.findByRole('heading', { name: 'Summary' })).closest('[data-tier]')
    expect(summary).toHaveAttribute('data-tier', 'prod')
    expect(summary?.textContent).toContain('shop')
    expect(summary?.textContent).toContain('production')
    expect(summary?.querySelector('[data-tier="production"]')).not.toBeNull()
    expect(summary?.textContent).toContain('orders')
  })

  it('does not call the server for an incomplete form and names the missing choices', async () => {
    const world = new World()
    mountApp('/targets/register', world)
    await screen.findByLabelText('Product')
    fireEvent.click(screen.getByRole('button', { name: 'Create registration plan' }))
    expect(await screen.findAllByText('Choose one.')).not.toHaveLength(0)
    expect(screen.getByText('Choose every field to see the summary.')).toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(world.posts('/api/v1/targets')).toHaveLength(0)
  })

  it('asks for confirmation, creates the plan and opens it for review', async () => {
    const world = new World()
    const { router } = mountApp('/targets/register', world)
    await fillAll()
    fireEvent.click(await screen.findByRole('button', { name: 'Create registration plan' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Create the registration plan?')).toBeInTheDocument()
    // Nothing was sent before the confirmation.
    expect(world.posts('/api/v1/targets')).toHaveLength(0)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create plan' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    const posts = world.posts('/api/v1/targets')
    expect(posts).toHaveLength(1)
    expect(posts[0]?.body).toEqual({
      projectId: PROJECT,
      environmentId: STAGING,
      databaseId: DATABASE,
    })
  })

  it('shows the production cue in the confirmation of a production registration', async () => {
    mountApp('/targets/register', new World())
    await fillAll(PRODUCTION)
    fireEvent.click(await screen.findByRole('button', { name: 'Create registration plan' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.querySelector('[data-slot="confirm-frame"]')).toHaveAttribute('data-tier', 'prod')
    expect(dialog.textContent).toContain('This changes a production target.')
  })

  it('cancels without sending anything', async () => {
    const world = new World()
    mountApp('/targets/register', world)
    await fillAll()
    fireEvent.click(await screen.findByRole('button', { name: 'Create registration plan' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(world.posts('/api/v1/targets')).toHaveLength(0)
  })

  it('shows the refusal with its code in the dialog and stays on the page', async () => {
    const world = new World()
    world.failures.set('POST /api/v1/targets', {
      status: 403,
      code: 'PERMISSION_DENIED',
      message: 'Production authority is needed.',
    })
    const { router } = mountApp('/targets/register', world)
    await fillAll()
    fireEvent.click(await screen.findByRole('button', { name: 'Create registration plan' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create plan' }))
    expect(await within(dialog).findByText(/Production authority is needed\./)).toBeInTheDocument()
    expect(within(dialog).getByText(/PERMISSION_DENIED/)).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/targets/register')
  })

  it('shows a failed read of the clusters as failed, not as "no cluster"', async () => {
    const world = new World()
    world.failures.set('GET /api/v1/clusters', {
      status: 500,
      code: 'INTERNAL',
      message: 'The registry did not answer.',
    })
    mountApp('/targets/register', world)
    expect(await screen.findByText('The registry did not answer.')).toBeInTheDocument()
    expect(screen.getByText(/Could not read Cluster/)).toBeInTheDocument()
    expect(screen.queryByText('No cluster is registered.')).toBeNull()
    expect(screen.queryByLabelText('Cluster')).toBeNull()
  })

  it('says a list is empty only after a successful read', async () => {
    const world = new World()
    world.clusters = []
    mountApp('/targets/register', world)
    expect(await screen.findByText('No cluster is registered.')).toBeInTheDocument()
  })

  it('shows names with hidden characters as marked text', async () => {
    const world = new World()
    world.clusters = [
      { ...world.firstCluster(), displayName: `main${BIDI}<script>alert(1)</script>` },
    ]
    mountApp('/targets/register', world)
    await fillAll()
    const summary = (await screen.findByRole('heading', { name: 'Summary' })).closest('div')
    await waitFor(() => expect(summary?.textContent).toContain('⟨U+202E⟩'))
    expect(summary?.textContent).not.toContain(BIDI)
    expect(document.querySelector('script')).toBeNull()
  })

  it('has no accessibility violations empty, filled and with the dialog open', async () => {
    mountApp('/targets/register', new World())
    await screen.findByLabelText('Product')
    expect(await axeViolations(document.body)).toEqual([])
    await fillAll(PRODUCTION)
    await screen.findByRole('heading', { name: 'Summary' })
    expect(await axeViolations(document.body)).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Create registration plan' }))
    await screen.findByRole('alertdialog')
    expect(await axeViolations(document.body)).toEqual([])
  })
})
