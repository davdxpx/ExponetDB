import '@testing-library/jest-dom/vitest'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { dataReadOf } from '../../src/features/configuration/data-read.ts'
import {
  BIDI,
  HOSTILE,
  mountOps,
  nth,
  OpsWorld,
  PROD_TARGET,
  project,
  TARGET,
  ulid,
  withDefaults,
} from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

afterEach(cleanup)

const PAGE = `/t/${TARGET}/configuration`
const POLICY = /\/api\/v1\/policy-settings$/
const CLUSTER = `cls_${ulid(1)}`
const CREDENTIALS = new RegExp(`/api/v1/clusters/${CLUSTER}/credentials$`)

const TARGET_ID = 'tgt_00000000000000000000000002'

function setting(scopeKind: string, scopeId: string, revision: number, params: unknown) {
  return {
    scopeKind,
    scopeId,
    revision,
    params,
    createdAt: new Date().toISOString(),
    operationId: null,
  }
}

function policy(settings: unknown[] = []) {
  return {
    rules: [
      {
        id: 'data.read',
        version: 1,
        description: 'Who may read rows.',
        appliesTo: ['query.run'],
        severity: 'deny',
        defaults: { mode: 'by_tier', sensitiveColumns: [] },
        settings,
      },
    ],
  }
}

function world(): OpsWorld {
  const w = new OpsWorld()
  project(w)
  w.sample(TARGET)
  withDefaults(w)
  w.on('GET', POLICY, policy())
  w.update(TARGET, {
    placement: {
      clusterId: CLUSTER,
      clusterName: 'main',
      generation: 1,
      managementMode: 'external',
      postgresVersion: '17.2',
      serverName: null,
      since: new Date().toISOString(),
    },
  })
  w.on('GET', CREDENTIALS, {
    items: [
      {
        id: 'crd_1',
        clusterId: CLUSTER,
        roleName: 'exdb_reader',
        accessRole: 'reader',
        state: 'active',
        failureCode: null,
        verifiedAt: new Date().toISOString(),
        version: 1,
        submittedAt: new Date().toISOString(),
        submittedBy: 'x',
        stateChangedAt: new Date().toISOString(),
      },
    ],
    truncated: false,
  })
  return w
}

async function section(name: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { level: 2, name })
  const root = heading.closest('[data-slot="page-section"]')
  if (!(root instanceof HTMLElement)) throw new Error(`no section ${name}`)
  return root
}

describe('the data-read policy model', () => {
  const ids = {
    target: TARGET_ID,
    environment: 'env_1',
    project: 'prj_1',
    product: 'prd_1',
  }

  it('takes the most specific setting, the newest revision, else the default', () => {
    expect(dataReadOf(policy() as never, ids)).toMatchObject({ from: 'default', mode: 'by_tier' })
    const settings = policy([
      setting('installation', 'ins_1', 5, { mode: 'enabled', sensitiveColumns: [] }),
      setting('project', 'prj_1', 1, { mode: 'humans_only', sensitiveColumns: ['a.b.*'] }),
      setting('project', 'prj_1', 2, { mode: 'disabled', sensitiveColumns: [] }),
      setting('project', 'prj_other', 9, { mode: 'enabled', sensitiveColumns: [] }),
    ])
    expect(dataReadOf(settings as never, ids)).toMatchObject({
      from: 'project',
      revision: 2,
      mode: 'disabled',
    })
    const targeted = policy([
      ...nth(settings.rules, 0).settings,
      setting('target', TARGET_ID, 1, { mode: 'humans_only', sensitiveColumns: ['x.y.z'] }),
    ])
    expect(dataReadOf(targeted as never, ids)).toMatchObject({
      from: 'target',
      mode: 'humans_only',
      sensitiveColumns: ['x.y.z'],
    })
  })

  it('reads a setting that does not parse as unreadable, never as a mode', () => {
    expect(
      dataReadOf(policy([setting('target', TARGET_ID, 1, { mode: 'everyone' })]) as never, ids),
    ).toMatchObject({ mode: 'unreadable' })
    expect(dataReadOf({ rules: [] } as never, ids)).toBeUndefined()
  })
})

describe('the configuration page', () => {
  it('shows the target facts, the data-read default, the cluster roles and the PostgreSQL named state', async () => {
    mountOps(PAGE, world())
    const target = await section('Target')
    expect(within(target).getByText('shop/platform/staging')).toBeInTheDocument()
    expect(within(target).getByRole('link', { name: 'Open the cluster' })).toHaveAttribute(
      'href',
      `/infrastructure/clusters/${CLUSTER}`,
    )
    const dataRead = await section('Data-read policy')
    expect(await within(dataRead).findByText(/By tier: people read every tier/)).toBeInTheDocument()
    expect(within(dataRead).getByText(/rule default/)).toBeInTheDocument()
    expect(within(dataRead).getByRole('link', { name: 'Open policies' })).toHaveAttribute(
      'href',
      '/settings/policies',
    )
    const roles = await section('Cluster roles')
    const table = await within(roles).findByRole('table', {
      name: 'Roles of the cluster of this target',
    })
    expect(within(table).getByText('exdb_reader')).toBeInTheDocument()
    const postgres = await section('PostgreSQL settings')
    expect(
      within(postgres).getByText('PostgreSQL settings are not readable here yet'),
    ).toBeInTheDocument()
  })

  it('shows the setting configured for the target', async () => {
    const w = world()
    w.on(
      'GET',
      POLICY,
      policy([
        setting('target', TARGET_ID, 3, {
          mode: 'humans_only',
          sensitiveColumns: ['public.users.email'],
        }),
      ]),
    )
    mountOps(PAGE, w)
    const dataRead = await section('Data-read policy')
    expect(
      await within(dataRead).findByText(/People only: agents read no rows/),
    ).toBeInTheDocument()
    expect(within(dataRead).getByText('This target, revision 3')).toBeInTheDocument()
    expect(within(dataRead).getByText('public.users.email')).toBeInTheDocument()
  })

  it('names the missing permission for the policy and never invents a mode', async () => {
    const w = world()
    w.fail('GET', POLICY, 403, 'PERMISSION_DENIED')
    mountOps(PAGE, w)
    const dataRead = await section('Data-read policy')
    expect(await within(dataRead).findByText('access.read')).toBeInTheDocument()
    expect(within(dataRead).queryByText(/By tier/)).toBeNull()
  })

  it('shows failed reads as failed', async () => {
    const w = world()
    w.fail('GET', POLICY, 500, 'INTERNAL_ERROR')
    w.fail('GET', CREDENTIALS, 500, 'INTERNAL_ERROR')
    mountOps(PAGE, w)
    expect(await screen.findByText(/Could not read data-read policy/)).toBeInTheDocument()
    expect(await screen.findByText(/Could not read cluster roles/)).toBeInTheDocument()
    expect(screen.queryByText(/found no cluster roles/)).toBeNull()
  })

  it('says a target without a cluster has no cluster roles, and asks nothing about one', async () => {
    const w = world()
    w.update(TARGET, { placement: null })
    mountOps(PAGE, w)
    expect(
      await screen.findByText(
        'This target is not placed on a cluster, so it has no cluster roles.',
      ),
    ).toBeInTheDocument()
    expect(w.callsTo('GET', /credentials/)).toHaveLength(0)
  })

  it('renders hostile cluster and role names as marked text', async () => {
    const w = world()
    w.update(TARGET, {
      placement: {
        clusterId: CLUSTER,
        clusterName: HOSTILE,
        generation: 1,
        managementMode: 'external',
        postgresVersion: null,
        serverName: null,
        since: new Date().toISOString(),
      },
    })
    w.on('GET', CREDENTIALS, {
      items: [
        {
          id: 'crd_1',
          clusterId: CLUSTER,
          roleName: `r${BIDI}`,
          accessRole: 'reader',
          state: 'active',
          failureCode: null,
          verifiedAt: null,
          version: 1,
          submittedAt: new Date().toISOString(),
          submittedBy: 'x',
          stateChangedAt: new Date().toISOString(),
        },
      ],
      truncated: false,
    })
    mountOps(PAGE, w)
    const roles = await section('Cluster roles')
    await within(roles).findByRole('table', { name: 'Roles of the cluster of this target' })
    const page = document.body
    expect(page.querySelector('script')).toBeNull()
    expect(page.textContent).toContain('⟨U+202E⟩')
    expect(page.textContent).not.toContain(BIDI)
    expect(within(roles).getByText('Not verified')).toBeInTheDocument()
  })

  it('shows an old read of the policy and of the roles as stale, with their age and a refresh', async () => {
    const w = world()
    const { queryClient } = mountOps(PAGE, w)
    const roles = await section('Cluster roles')
    await within(roles).findByRole('table', { name: 'Roles of the cluster of this target' })
    w.fail('GET', POLICY, 400, 'VALIDATION_FAILED')
    w.fail('GET', CREDENTIALS, 400, 'VALIDATION_FAILED')
    await act(async () => {
      await queryClient.refetchQueries()
    })
    await waitFor(() =>
      expect(screen.getAllByText(/Showing an earlier read of/i).length).toBeGreaterThanOrEqual(2),
    )
    expect(document.querySelector('[data-state="stale"]')?.textContent).toMatch(/Observed/)
    expect(screen.getAllByRole('button', { name: 'Refresh' }).length).toBeGreaterThanOrEqual(2)
    expect(
      within(await section('Cluster roles')).getByRole('table', {
        name: 'Roles of the cluster of this target',
      }),
    ).toBeVisible()
  })

  it('names what is missing when the roles are cut off, and is empty only after a successful read', async () => {
    const cut = world()
    cut.on('GET', CREDENTIALS, { items: [], truncated: true })
    mountOps(PAGE, cut)
    const roles = await section('Cluster roles')
    expect(await within(roles).findByText('More roles exist than this list shows.')).toBeVisible()
    cleanup()

    const empty = world()
    empty.on('GET', CREDENTIALS, { items: [], truncated: false })
    mountOps(PAGE, empty)
    const none = await section('Cluster roles')
    expect(await within(none).findByText(/found no cluster roles/i)).toBeVisible()
    expect(within(none).queryByText(/Could not read/)).toBeNull()
  })

  it('says Production by the title of a production target', async () => {
    const w = new OpsWorld()
    project(w)
    w.sample(PROD_TARGET)
    withDefaults(w, PROD_TARGET)
    w.on('GET', POLICY, policy())
    mountOps(`/t/${PROD_TARGET}/configuration`, w)
    await section('Target')
    await waitFor(() =>
      expect(document.querySelector('[data-slot="page-header-production-cue"]')).not.toBeNull(),
    )
    expect(screen.getAllByText('Production').length).toBeGreaterThan(0)
  })

  it('has no accessibility violations', async () => {
    mountOps(PAGE, world())
    await screen.findByRole('table', { name: 'Roles of the cluster of this target' })
    await screen.findByText(/By tier: people read every tier/)
    expect(await axeViolations(document.body)).toEqual([])
  })
})
