import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  BIDI,
  findingFixture,
  fingerprintFixture,
  mountApp,
  objectFixture,
  overviewFixture,
  project,
  ref,
  World,
  ZWSP,
} from '../target-overview/support.tsx'

// The target pages run in the shortcut and command providers of the real shell, without the rail.
vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

// The diagram is a lazy chunk; the test replaces it and records what it was given.
const drawn = vi.hoisted(() => ({ last: undefined as unknown }))
vi.mock('@exponetdb/ui-data/erd/schema-erd', () => ({
  SchemaErd: (props: {
    readable: { state: string; value?: { tables: unknown[]; relations: unknown[] } }
  }) => {
    drawn.last = props.readable
    return createElement(
      'div',
      { 'data-testid': 'erd', 'data-state': props.readable.state },
      props.readable.value === undefined
        ? props.readable.state
        : `${props.readable.value.tables.length} tables, ${props.readable.value.relations.length} relations`,
    )
  },
}))

afterEach(() => {
  cleanup()
  drawn.last = undefined
})

const STAGING = 'shop/platform/staging'
const SCHEMA = '/t/shop/platform/staging/schema'

function readyWorld(): World {
  const world = new World()
  project(world)
  world.sample(STAGING)
  world.sample('shop/platform/production')
  world.overview = overviewFixture()
  world.fingerprint = fingerprintFixture()
  world.findings = [findingFixture()]
  const orders = ref({ name: 'orders' })
  const users = ref({ name: 'users' })
  world.refs = [orders, users]
  world.objects.set(
    'table|"public"."orders"',
    objectFixture(orders, {
      owner: 'app_owner',
      sizeBytes: 8192,
      columns: [
        {
          name: 'id',
          type: 'uuid',
          nullable: false,
          default: 'gen_random_uuid()',
          generated: null,
          identity: null,
        },
        {
          name: 'user_id',
          type: 'uuid',
          nullable: true,
          default: null,
          generated: null,
          identity: null,
        },
      ],
      constraints: [
        { name: 'orders_pk', type: 'primary_key', definition: 'PRIMARY KEY (id)', validated: true },
        {
          name: 'orders_user_fk',
          type: 'foreign_key',
          definition: 'FOREIGN KEY (user_id) REFERENCES public.users(id)',
          validated: false,
        },
      ],
      indexes: [
        {
          name: 'orders_pkey',
          definition: 'CREATE UNIQUE INDEX orders_pkey ON public.orders (id)',
          unique: true,
          valid: true,
        },
        {
          name: 'orders_bad',
          definition: 'CREATE INDEX orders_bad ON public.orders (user_id)',
          unique: false,
          valid: false,
        },
      ],
      policies: [],
      rowLevelSecurity: { enabled: true, forced: false },
      grants: [{ grantee: 'app_user', privileges: ['SELECT'] }],
    }),
  )
  world.objects.set(
    'table|"public"."users"',
    objectFixture(users, {
      columns: [
        {
          name: 'id',
          type: 'uuid',
          nullable: false,
          default: null,
          generated: null,
          identity: null,
        },
      ],
      constraints: [
        { name: 'users_pk', type: 'primary_key', definition: 'PRIMARY KEY (id)', validated: true },
      ],
    }),
  )
  return world
}

async function status() {
  return waitFor(() => {
    const found = document.querySelector('[data-block="schema-status"]')
    if (found === null) throw new Error('no status block')
    return found as HTMLElement
  })
}

async function search(term: string) {
  const user = userEvent.setup()
  const box = await screen.findByRole('textbox', {
    name: /Filter by name|Draw the tables whose name contains/,
  })
  await user.clear(box)
  await user.type(box, term)
  await user.click(screen.getByRole('button', { name: 'Show matching objects' }))
  return user
}

describe('the schema page: fingerprint, drift and the way to a change', () => {
  it('shows the fp1 fingerprint with source and age, drift and the draft link', async () => {
    mountApp(SCHEMA, readyWorld())
    const top = await status()
    const fingerprint = await waitFor(() => {
      const el = top.querySelector('[data-slot="fingerprint"]')
      if (el === null) throw new Error('no fingerprint yet')
      return el as HTMLElement
    })
    expect(fingerprint.textContent).toContain(`sha256:fp1:${'ab'.repeat(32)}`)
    expect(fingerprint.textContent).toContain('fp1')
    expect(within(fingerprint).getByText('Live')).toBeInTheDocument()
    const drift = await waitFor(() => {
      const el = top.querySelector('[data-slot="drift"]')
      if (el === null) throw new Error('no drift yet')
      return el as HTMLElement
    })
    expect(drift).toHaveAttribute('data-open', '1')
    expect(drift.textContent).toContain('1 drift findings are open.')
    expect(drift.textContent).toContain('not a new check')
    expect(within(top).getByRole('link', { name: 'Draft a change' })).toHaveAttribute(
      'href',
      '/t/shop/platform/staging/sql?mode=draft',
    )
    expect(within(top).getByRole('link', { name: 'Open drift' })).toHaveAttribute(
      'href',
      '/t/shop/platform/staging/drift',
    )
  })

  it('has no button that changes the database', async () => {
    mountApp(SCHEMA, readyWorld())
    await status()
    await screen.findByRole('table', { name: /Schemas with the number of objects/ })
    const labels = screen.getAllByRole('button').map((b) => b.textContent ?? '')
    expect(labels.join('|')).not.toMatch(/drop|alter|run|execute|apply|create/i)
  })

  it('says no drift finding is open only after a successful read, and fails separately', async () => {
    const world = readyWorld()
    world.findings = []
    mountApp(SCHEMA, world)
    expect(await screen.findByText('No drift finding is open.')).toBeInTheDocument()
    cleanup()
    const failing = readyWorld()
    failing.failures.set('/findings', {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Findings store down.',
    })
    mountApp(SCHEMA, failing)
    expect(await screen.findByText(/Findings store down\./)).toBeInTheDocument()
    expect(screen.queryByText('No drift finding is open.')).toBeNull()
    // The fingerprint still shows.
    expect(await screen.findByText(`sha256:fp1:${'ab'.repeat(32)}`)).toBeInTheDocument()
  })

  it('shows a failed fingerprint read as failed, and an incomplete snapshot as such', async () => {
    const world = readyWorld()
    world.failures.set('/schema/fingerprint', {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Snapshot store down.',
    })
    mountApp(SCHEMA, world)
    expect(await screen.findByText(/Snapshot store down\./)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('sha256:fp1:')
    cleanup()
    const partial = readyWorld()
    partial.fingerprint = fingerprintFixture({
      complete: false,
      visibility: { complete: false, gapCount: 3, gaps: [], missingSchemas: ['secret'] },
    })
    mountApp(SCHEMA, partial)
    expect((await screen.findAllByText(/The snapshot is incomplete/)).length).toBeGreaterThan(0)
    expect(
      await screen.findByText(/3 attributes and 1 schemas were not visible/),
    ).toBeInTheDocument()
  })

  it('shows the production frame on a production target', async () => {
    mountApp('/t/shop/platform/production/schema', readyWorld())
    await status()
    const outlet = document.querySelector('[data-production-frame]')
    expect(outlet).not.toBeNull()
    expect(screen.getAllByText('Production').length).toBeGreaterThan(0)
  })
})

describe('the schema overview', () => {
  it('lists schemas with counts and links each class to its page', async () => {
    mountApp(SCHEMA, readyWorld())
    const table = await screen.findByRole('table', { name: /Schemas with the number of objects/ })
    const row = within(table)
      .getAllByRole('row')
      .find((r) => r.textContent?.includes('public'))
    expect(row).toBeDefined()
    if (row === undefined) return
    expect(within(row).getByRole('link', { name: 'Tables' })).toHaveAttribute(
      'href',
      '/t/shop/platform/staging/schema/tables',
    )
    expect(row.textContent).toContain('Indexes')
    expect(within(row).getAllByText('3').length).toBeGreaterThan(0)
  })

  it('shows a failed overview as failed, and a partial one with what it could not see', async () => {
    const world = readyWorld()
    // Only the overview read fails; the fingerprint path (`/schema/fingerprint`) does not.
    world.failuresExact.set('/api/v1/targets/shop%2Fplatform%2Fstaging/schema', {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Inventory unavailable.',
    })
    mountApp(SCHEMA, world)
    expect((await screen.findAllByText(/Inventory unavailable\./)).length).toBeGreaterThan(0)
    expect(screen.queryByText('The read succeeded and found no schema.')).toBeNull()
    cleanup()
    const partial = readyWorld()
    partial.overview = overviewFixture({
      visibility: { complete: false, gapCount: 2, gaps: [], missingSchemas: ['hidden'] },
    })
    mountApp(SCHEMA, partial)
    expect((await screen.findAllByText(/Showing part of schemas/)).length).toBeGreaterThan(0)
  })

  it('shows an old read of the overview and the fingerprint as stale, with their age and a refresh', async () => {
    const world = readyWorld()
    const old = new Date(Date.now() - 10 * 60_000).toISOString()
    world.overview = overviewFixture({ observedAt: old })
    world.fingerprint = fingerprintFixture({ observedAt: old })
    mountApp(SCHEMA, world)
    await waitFor(() =>
      expect(document.querySelectorAll('[data-state="stale"]').length).toBeGreaterThanOrEqual(2),
    )
    for (const banner of document.querySelectorAll('[data-state="stale"]')) {
      expect(banner.textContent).toMatch(/Showing an earlier read of .*Observed/)
    }
    expect(screen.getAllByRole('button', { name: 'Refresh' }).length).toBeGreaterThanOrEqual(2)
  })

  it('shows an old read of an object as stale, with its age and a refresh, keeping the details', async () => {
    const world = readyWorld()
    const key = 'table|"public"."orders"'
    const found = world.objects.get(key)
    if (found === undefined) throw new Error('no fixture')
    world.objects.set(key, {
      ...found,
      observedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    })
    mountApp(`${SCHEMA}/tables`, world)
    const user = await search('ord')
    const table = await screen.findByRole('table', { name: 'Schema objects' })
    await user.click(within(table).getByRole('button', { name: 'orders' }))
    expect(await screen.findByText(/Showing an earlier read of object details/)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Refresh' }).length).toBeGreaterThan(0)
  })

  it('says a database without schemas has none only after a successful read', async () => {
    const world = readyWorld()
    world.overview = overviewFixture({ schemas: [] })
    mountApp(SCHEMA, world)
    expect(await screen.findByText('The read succeeded and found no schema.')).toBeInTheDocument()
  })
})

describe('the object lists', () => {
  it('lists every object of the kind when the page opens, without a filter, 100 at a time', async () => {
    const world = readyWorld()
    mountApp(`${SCHEMA}/tables`, world)
    const table = await screen.findByRole('table', { name: 'Schema objects' })
    expect(within(table).getByRole('button', { name: 'orders' })).toBeInTheDocument()
    expect(within(table).getByRole('button', { name: 'users' })).toBeInTheDocument()
    const request = world.requests.find((r) => r.includes('/schema/objects?')) ?? ''
    expect(request).toContain('kinds=table')
    expect(request).toContain('limit=100')
    expect(request).not.toContain('q=')
    expect(request).not.toContain('schema=')
    expect(world.requests.some((r) => r.includes('/schema/search'))).toBe(false)
    // The count, the source and the age of the read are on the page.
    const count = document.querySelector('[data-slot="list-count"]') as HTMLElement
    expect(count.textContent).toContain('Showing all 2 objects.')
    expect(within(count).getByText('Live')).toBeInTheDocument()
    expect(count.querySelector('time')).not.toBeNull()
  })

  it('sends the name filter as q and lists the matches', async () => {
    const world = readyWorld()
    mountApp(`${SCHEMA}/tables`, world)
    await screen.findByRole('table', { name: 'Schema objects' })
    await search('ord')
    await waitFor(() =>
      expect(
        world.requests.some((r) => r.includes('/schema/objects?') && r.includes('q=ord')),
      ).toBe(true),
    )
    await waitFor(() => {
      const table = screen.getByRole('table', { name: 'Schema objects' })
      expect(within(table).queryByText('users')).toBeNull()
      expect(within(table).getByRole('button', { name: 'orders' })).toBeInTheDocument()
    })
    const request = world.requests.filter((r) => r.includes('q=ord')).at(-1) ?? ''
    expect(request).toContain('kinds=table')
  })

  it('says the list is empty only after a successful empty read, with or without a filter', async () => {
    const world = readyWorld()
    mountApp(`${SCHEMA}/tables`, world)
    await screen.findByRole('table', { name: 'Schema objects' })
    await search('zzz')
    expect(
      await screen.findByText('The read succeeded and found no object with that name.'),
    ).toBeInTheDocument()
    cleanup()
    const none = readyWorld()
    none.refs = []
    mountApp(`${SCHEMA}/tables`, none)
    expect(
      await screen.findByText(
        'The read succeeded and found no object of this kind in the schemas shown.',
      ),
    ).toBeInTheDocument()
  })

  it('shows a failed list read as failed, never as an empty list', async () => {
    const world = readyWorld()
    world.failures.set('/schema/objects?', {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'The list is down.',
    })
    mountApp(`${SCHEMA}/tables`, world)
    expect(await screen.findByText(/The list is down\./)).toBeInTheDocument()
    expect(screen.queryByText(/found no object/)).toBeNull()
    expect(screen.queryByRole('table', { name: 'Schema objects' })).toBeNull()
  })

  it('pages by cursor: shows N of the total, loads more, and ends with all of them', async () => {
    const world = readyWorld()
    world.objectsPageSize = 1
    mountApp(`${SCHEMA}/tables`, world)
    const user = userEvent.setup()
    const count = async () =>
      (
        await waitFor(() => {
          const el = document.querySelector('[data-slot="list-count"]')
          if (el === null) throw new Error('no count yet')
          return el
        })
      ).textContent ?? ''
    expect(await count()).toContain('Showing 1 of 2 objects.')
    const table = screen.getByRole('table', { name: 'Schema objects' })
    expect(within(table).getAllByRole('button')).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Load more objects' }))
    await waitFor(() => expect(within(table).getAllByRole('button')).toHaveLength(2))
    expect(await count()).toContain('Showing all 2 objects.')
    expect(screen.queryByRole('button', { name: 'Load more objects' })).toBeNull()
    const listed = world.requests.filter((r) => r.includes('/schema/objects?'))
    expect(listed).toHaveLength(2)
    expect(listed[0]).not.toContain('cursor=')
    expect(listed[1]).toContain('cursor=')
  })

  it('starts again from the first page and says so when the schema changed between pages', async () => {
    const world = readyWorld()
    world.objectsPageSize = 1
    mountApp(`${SCHEMA}/tables`, world)
    const user = userEvent.setup()
    await screen.findByRole('table', { name: 'Schema objects' })
    // The cursor of the first page now belongs to an older snapshot.
    world.objectsFingerprint = `fp1:17:${'cd'.repeat(32)}`
    await user.click(await screen.findByRole('button', { name: 'Load more objects' }))
    expect(
      await screen.findByText(
        /The schema changed while you were paging, so the list started again/,
      ),
    ).toBeInTheDocument()
    const listed = world.requests.filter((r) => r.includes('/schema/objects?'))
    // The refused page, then the first page again without a cursor.
    expect(listed.filter((r) => r.includes('cursor=')).length).toBe(1)
    expect(listed.at(-1)).not.toContain('cursor=')
    const table = await screen.findByRole('table', { name: 'Schema objects' })
    expect(within(table).getAllByRole('button')).toHaveLength(1)
    expect(screen.queryByRole('alert')).toBeNull()
    // Loading on from the new first page works under the new snapshot.
    await user.click(screen.getByRole('button', { name: 'Load more objects' }))
    await waitFor(() => expect(within(table).getAllByRole('button')).toHaveLength(2))
    expect(screen.queryByText(/The schema changed while you were paging/)).toBeNull()
  })

  it('keeps the pages read and says so when a later page fails', async () => {
    const world = readyWorld()
    world.objectsPageSize = 1
    world.failures.set('cursor=', {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'The next page is down.',
    })
    mountApp(`${SCHEMA}/tables`, world)
    const user = userEvent.setup()
    await screen.findByRole('table', { name: 'Schema objects' })
    await user.click(await screen.findByRole('button', { name: 'Load more objects' }))
    expect(
      await screen.findByText(/Could not read the next objects: The next page is down\./),
    ).toBeInTheDocument()
    // The first page is still there, and the read is not shown as failed or empty.
    const table = screen.getByRole('table', { name: 'Schema objects' })
    expect(within(table).getAllByRole('button')).toHaveLength(1)
    expect(screen.queryByText(/found no object/)).toBeNull()
    // The same button reads the page again.
    expect(screen.getByRole('button', { name: 'Load more objects' })).toBeEnabled()
  })

  it('names an incomplete snapshot as a partial list, not as the whole', async () => {
    const world = readyWorld()
    world.objectsComplete = false
    mountApp(`${SCHEMA}/tables`, world)
    expect(
      (
        await screen.findAllByText(
          /Part of the schema could not be read, so this list may miss objects/,
        )
      ).length,
    ).toBeGreaterThan(0)
    expect(screen.getByText(/Showing part of tables/)).toBeInTheDocument()
    expect(
      within(await screen.findByRole('table', { name: 'Schema objects' })).getByRole('button', {
        name: 'orders',
      }),
    ).toBeInTheDocument()
    // An incomplete snapshot with nothing read is not "no object".
    cleanup()
    const none = readyWorld()
    none.objectsComplete = false
    none.refs = []
    mountApp(`${SCHEMA}/tables`, none)
    expect(
      await screen.findByText(/No object was read, and the snapshot is incomplete/),
    ).toBeInTheDocument()
    expect(screen.queryByText(/found no object/)).toBeNull()
  })

  it('shows an old snapshot of the list as stale, with its age and a refresh', async () => {
    const world = readyWorld()
    world.objectsObservedAt = new Date(Date.now() - 10 * 60_000).toISOString()
    mountApp(`${SCHEMA}/tables`, world)
    expect(await screen.findByText(/Showing an earlier read of tables/)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Refresh' }).length).toBeGreaterThan(0)
    expect(
      within(await screen.findByRole('table', { name: 'Schema objects' })).getAllByRole('button'),
    ).toHaveLength(2)
  })

  it('reads an open list again every minute, like the overview, so it does not turn stale by waiting', async () => {
    const world = readyWorld()
    const { queryClient } = mountApp(`${SCHEMA}/tables`, world)
    await screen.findByRole('table', { name: 'Schema objects' })
    const lists = queryClient.getQueryCache().findAll({ queryKey: ['schema', 'objects'] })
    expect(lists).toHaveLength(1)
    expect(lists[0]?.observers[0]?.options.refetchInterval).toBe(60_000)
  })

  it('names the source of a read that is not live', async () => {
    const world = readyWorld()
    world.objectsSource = 'sampled'
    mountApp(`${SCHEMA}/tables`, world)
    const count = await waitFor(() => {
      const el = document.querySelector('[data-slot="list-count"]')
      if (el === null) throw new Error('no count yet')
      return el as HTMLElement
    })
    expect(within(count).getByText('Sampled')).toBeInTheDocument()
  })

  it('shows the details of an object: structure, flags, size, grants', async () => {
    const world = readyWorld()
    mountApp(`${SCHEMA}/tables`, world)
    const user = await search('ord')
    const table = await screen.findByRole('table', { name: 'Schema objects' })
    await user.click(within(table).getByRole('button', { name: 'orders' }))
    const panel = await waitFor(() => {
      const el = document.querySelector('[data-slot="object-detail"]')
      if (el === null) throw new Error('no detail yet')
      return el as HTMLElement
    })
    expect(within(panel).getByRole('table', { name: 'Columns' })).toBeInTheDocument()
    expect(within(panel).getByRole('table', { name: 'Constraints' })).toBeInTheDocument()
    expect(within(panel).getByText('8.0 KiB')).toBeInTheDocument()
    expect(within(panel).getByText('Not validated')).toBeInTheDocument()
    expect(within(panel).getByText('Invalid')).toBeInTheDocument()
    expect(within(panel).getByRole('table', { name: 'Privileges' })).toBeInTheDocument()
    expect(panel.querySelector('[data-hint="rls-no-policy"]')).not.toBeNull()
    expect(panel.querySelector('[data-hint="invalid-index"]')).not.toBeNull()
    expect(panel.querySelector('[data-hint="unvalidated-constraint"]')).not.toBeNull()
    expect(
      within(panel).getByText(/How often an index is used is not part of this read/),
    ).toBeInTheDocument()
    expect(
      world.requests.some((r) => r.includes('/schema/objects/table/%22public%22.%22orders%22')),
    ).toBe(true)
  })

  it('shows a failed object read as failed', async () => {
    const world = readyWorld()
    world.objects.clear()
    mountApp(`${SCHEMA}/tables`, world)
    const user = await search('ord')
    const table = await screen.findByRole('table', { name: 'Schema objects' })
    await user.click(within(table).getByRole('button', { name: 'orders' }))
    expect(
      await screen.findByText(/This does not mean there is no object details/),
    ).toBeInTheDocument()
  })

  it('flags a SECURITY DEFINER function without search_path and shows the body bounded', async () => {
    const world = readyWorld()
    const fn = ref({
      kind: 'function',
      name: 'grant_all',
      signature: 'integer',
      key: ['public', 'grant_all', 'integer'],
    })
    world.refs = [fn]
    const body = `BEGIN\n${'-- padding line\n'.repeat(200)}END`
    world.objects.set(
      'function|"public"."grant_all"(integer)',
      objectFixture(fn, {
        definition: `CREATE OR REPLACE FUNCTION public.grant_all(n integer)\n RETURNS void\n LANGUAGE plpgsql\n SECURITY DEFINER\nAS $function$ ${body} $function$\n`,
      }),
    )
    mountApp(`${SCHEMA}/functions`, world)
    const user = await search('grant')
    await user.click(await screen.findByRole('button', { name: 'grant_all' }))
    const panel = await waitFor(() => {
      const el = document.querySelector('[data-slot="object-detail"]')
      if (el === null) throw new Error('no detail yet')
      return el as HTMLElement
    })
    expect(panel.querySelector('[data-hint="security-definer"]')).not.toBeNull()
    const definition = panel.querySelector('[data-slot="definition"]') as HTMLElement
    expect(within(definition).getByRole('button', { name: /Show all/ })).toBeInTheDocument()
    // The body is cut: the last line is not in the page until asked for.
    expect(definition.textContent).not.toContain('END $function$')
  })

  it('does not flag a function that sets search_path', async () => {
    const world = readyWorld()
    const fn = ref({
      kind: 'function',
      name: 'safe_fn',
      signature: '',
      key: ['public', 'safe_fn', ''],
    })
    world.refs = [fn]
    world.objects.set(
      'function|"public"."safe_fn"()',
      objectFixture(fn, {
        definition:
          "CREATE FUNCTION public.safe_fn()\n SECURITY DEFINER\n SET search_path TO 'public'\nAS $f$ SELECT 1 $f$\n",
      }),
    )
    mountApp(`${SCHEMA}/functions`, world)
    const user = await search('safe')
    await user.click(await screen.findByRole('button', { name: 'safe_fn' }))
    await waitFor(() =>
      expect(document.querySelector('[data-slot="object-detail"]')).not.toBeNull(),
    )
    expect(document.querySelector('[data-hint="security-definer"]')).toBeNull()
  })

  it('asks the server for the chosen schema, so the list is that schema and nothing else', async () => {
    const world = readyWorld()
    world.refs = [
      ref({ name: 'orders', schema: 'public' }),
      ref({ name: 'orders_log', schema: 'exponetdb', key: ['exponetdb', 'orders_log'] }),
    ]
    mountApp(`${SCHEMA}/tables`, world)
    const user = userEvent.setup()
    const first = await screen.findByRole('table', { name: 'Schema objects' })
    expect(within(first).getAllByRole('button')).toHaveLength(2)
    await user.click(screen.getByRole('combobox', { name: /Schema/ }))
    await user.click(await screen.findByRole('option', { name: 'exponetdb' }))
    await waitFor(() => {
      const table = screen.getByRole('table', { name: 'Schema objects' })
      expect(
        within(table)
          .getAllByRole('button')
          .map((b) => b.textContent),
      ).toEqual(['orders_log'])
    })
    const request = world.requests.filter((r) => r.includes('/schema/objects?')).at(-1) ?? ''
    expect(request).toContain('schema=exponetdb')
    expect(request).toContain('kinds=table')
    expect(request).not.toContain('q=')
  })

  it('lists policies under the table they belong to, with the schema and the name as text', async () => {
    const world = readyWorld()
    const policy = (name: string, parent: string | null, schema = 'public') =>
      ref({ kind: 'policy', name, parent, schema, key: [schema, String(parent), name] })
    world.refs = [
      policy('own_rows', 'orders'),
      policy('admin_all', 'orders'),
      policy('read_all', 'users'),
      policy(`odd${BIDI}policy`, `t${BIDI}x`),
    ]
    mountApp(`${SCHEMA}/policies`, world)
    const table = await screen.findByRole('table', { name: 'Schema objects' })
    const groups = Array.from(table.querySelectorAll('tbody[data-group]'))
    expect(groups).toHaveLength(3)
    const titles = groups.map(
      (group) => group.querySelector('th[scope="rowgroup"]')?.textContent ?? '',
    )
    expect(titles[0]).toContain('Table')
    expect(titles[0]).toContain('public.orders')
    expect(titles[0]).toContain('Policies read: 2')
    expect(titles[1]).toContain('public.t⟨U+202E⟩')
    expect(titles[2]).toContain('public.users')
    expect(table.textContent).not.toContain(BIDI)
    expect(
      within(groups[0] as HTMLElement)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['admin_all', 'own_rows'])
    // The request is the plain list of the kind: the grouping is the page's, not a filter.
    const request = world.requests.find((r) => r.includes('/schema/objects?')) ?? ''
    expect(request).toContain('kinds=policy')
    expect(request).not.toContain('parent=')
    expect(document.querySelector('[data-slot="list-group-note"]')?.textContent).toContain(
      'Grouped by table',
    )
  })

  it('does not group the other kinds', async () => {
    mountApp(`${SCHEMA}/tables`, readyWorld())
    const table = await screen.findByRole('table', { name: 'Schema objects' })
    expect(table.querySelector('tbody[data-group]')).toBeNull()
    expect(within(table).getByRole('columnheader', { name: 'Belongs to' })).toBeInTheDocument()
  })

  it('shows roles as a named state that is not supported, not as an empty list', async () => {
    mountApp(`${SCHEMA}/roles`, readyWorld())
    expect(await screen.findByText(/Roles needs a cluster-level read of roles/)).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('answers an unknown kind with the not-found page', async () => {
    mountApp(`${SCHEMA}/not-a-kind`, readyWorld())
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Page not found' }),
    ).toBeInTheDocument()
  })
})

describe('hostile identifiers', () => {
  const NAMES = [
    'tab"le',
    'a$$b',
    `bidi${BIDI}name`,
    `zero${ZWSP}wida`,
    '<script>alert(1)</script>',
    `a${'n'.repeat(62)}`,
  ]

  it('shows them as text, with code points for hidden characters, and asks for them quoted', async () => {
    const world = readyWorld()
    world.refs = NAMES.map((name) => ref({ name, key: ['public', name] }))
    for (const reference of world.refs) {
      world.objects.set(
        `table|"public"."${reference.name.replaceAll('"', '""')}"`,
        objectFixture(reference, { comment: `<img src=x onerror=alert(1)> ${BIDI}` }),
      )
    }
    mountApp(`${SCHEMA}/tables`, world)
    const user = await search('a')
    const table = await screen.findByRole('table', { name: 'Schema objects' })
    const text = table.textContent ?? ''
    expect(text).toContain('⟨U+202E⟩')
    expect(text).toContain('⟨U+200B⟩')
    expect(text).toContain('<script>alert(1)</script>')
    expect(text).not.toContain(BIDI)
    expect(text).not.toContain(ZWSP)
    expect(document.querySelector('script:not([src])')).toBeNull()
    await user.click(within(table).getByRole('button', { name: /^tab.?le$/ }))
    await waitFor(() =>
      expect(document.querySelector('[data-slot="object-detail"]')).not.toBeNull(),
    )
    expect(world.requests.some((r) => r.includes(encodeURIComponent('"public"."tab""le"')))).toBe(
      true,
    )
    expect(document.querySelector('img')).toBeNull()
    expect(document.body.textContent).not.toContain(BIDI)
  })

  it('shows hostile schema names in the overview without letting them act', async () => {
    const world = readyWorld()
    world.overview = overviewFixture({
      schemas: [{ name: `s${BIDI}x`, managed: false, objectCounts: { [`odd${BIDI}class`]: 1 } }],
    })
    mountApp(SCHEMA, world)
    const table = await screen.findByRole('table', { name: /Schemas with the number of objects/ })
    expect(table.textContent).toContain('⟨U+202E⟩')
    expect(table.textContent).not.toContain(BIDI)
  })
})

describe('the tree', () => {
  it('lists the objects of a class of a schema when it opens, without a filter', async () => {
    const user = userEvent.setup()
    const world = readyWorld()
    world.refs = [
      ref({ name: 'orders' }),
      ref({ name: 'users' }),
      ref({ name: 'orders_log', schema: 'exponetdb', key: ['exponetdb', 'orders_log'] }),
    ]
    mountApp(SCHEMA, world)
    const tree = await screen.findByRole('tree', { name: 'Schemas and their objects' })
    await user.click(within(tree).getByText('public'))
    const publicItem = within(tree).getByRole('treeitem', { name: /public/ })
    await user.click(within(publicItem).getByText('Tables'))
    expect(await within(tree).findByText('orders')).toBeInTheDocument()
    expect(within(tree).getByText('users')).toBeInTheDocument()
    // The server narrowed it to the schema the class is under.
    expect(within(tree).queryByText('orders_log')).toBeNull()
    const request = world.requests.find((r) => r.includes('/schema/objects?')) ?? ''
    expect(request).toContain('kinds=table')
    expect(request).toContain('schema=public')
    expect(request).toContain('limit=200')
    expect(request).not.toContain('q=')
    expect(within(tree).queryByText(/found no/i)).toBeNull()
  })

  it('says a class with more objects than one read is partial, with the count and the way to the rest', async () => {
    const user = userEvent.setup()
    const world = readyWorld()
    world.objectsPageSize = 1
    mountApp(SCHEMA, world)
    const tree = await screen.findByRole('tree', { name: 'Schemas and their objects' })
    await user.click(within(tree).getByText('public'))
    await user.click(
      within(within(tree).getByRole('treeitem', { name: /public/ })).getByText('Tables'),
    )
    expect(
      await within(tree).findByText(
        /Showing the first 1 of 2 objects of this class\. Open the full list/,
      ),
    ).toBeInTheDocument()
    expect(within(tree).getByText('orders')).toBeInTheDocument()
    expect(within(tree).queryByText('users')).toBeNull()
  })

  it('names an incomplete snapshot in a class as partial', async () => {
    const user = userEvent.setup()
    const world = readyWorld()
    world.objectsComplete = false
    mountApp(SCHEMA, world)
    const tree = await screen.findByRole('tree', { name: 'Schemas and their objects' })
    await user.click(within(tree).getByText('public'))
    await user.click(
      within(within(tree).getByRole('treeitem', { name: /public/ })).getByText('Tables'),
    )
    expect(
      await within(tree).findByText(
        /Part of the schema could not be read, so this list may miss objects/,
      ),
    ).toBeInTheDocument()
    expect(within(tree).getByText('orders')).toBeInTheDocument()
  })
})

describe('the tree with a filter', () => {
  async function openTables(user: ReturnType<typeof userEvent.setup>) {
    const tree = await screen.findByRole('tree', { name: 'Schemas and their objects' })
    await user.click(within(tree).getByText('public'))
    const publicItem = within(tree).getByRole('treeitem', { name: /public/ })
    await user.click(within(publicItem).getByText('Tables'))
    return tree
  }

  async function applyFilter(user: ReturnType<typeof userEvent.setup>, term: string) {
    const box = await screen.findByRole('textbox', { name: 'Filter the tree by name' })
    await user.type(box, term)
    await user.click(screen.getByRole('button', { name: 'Show matching objects' }))
  }

  it('reads a class when it opens, keeps only the objects of the schema, and selects one', async () => {
    const user = userEvent.setup()
    const world = readyWorld()
    world.refs = [
      ref({ name: 'orders' }),
      ref({ name: 'orders_log', schema: 'exponetdb', key: ['exponetdb', 'orders_log'] }),
    ]
    mountApp(SCHEMA, world)
    await applyFilter(user, 'ord')
    const tree = await openTables(user)
    expect(await within(tree).findByText('orders')).toBeInTheDocument()
    expect(within(tree).queryByText('orders_log')).toBeNull()
    const request = world.requests.find((r) => r.includes('/schema/objects?')) ?? ''
    expect(request).toContain('kinds=table')
    expect(request).toContain('limit=200')
    expect(request).toContain('q=ord')
    expect(request).toContain('schema=public')
  })

  it('shows a class that failed to load as failed, with a retry, not as empty', async () => {
    const user = userEvent.setup()
    const world = readyWorld()
    world.failures.set('/schema/objects?', {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'The list is down.',
    })
    mountApp(SCHEMA, world)
    await applyFilter(user, 'ord')
    const tree = await openTables(user)
    expect(await within(tree).findByText(/The list is down\./)).toBeInTheDocument()
    expect(within(tree).getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(within(tree).queryByText(/found no/i)).toBeNull()
  })
})

describe('the diagram', () => {
  it('loads the diagram chunk on demand and draws the tables with their foreign keys', async () => {
    const world = readyWorld()
    mountApp(`${SCHEMA}/visualizer`, world)
    expect(
      await screen.findByText(/Choose a schema or enter part of a table name to draw tables/),
    ).toBeInTheDocument()
    // Nothing is listed or read for the details before one of them is chosen.
    expect(world.requests.some((r) => r.includes('/schema/objects'))).toBe(false)
    await search('r')
    const erd = await screen.findByTestId('erd')
    await waitFor(() => expect(erd).toHaveAttribute('data-state', 'ready'))
    expect(erd).toHaveTextContent('2 tables, 1 relations')
  })

  it('counts the tables it could not read and says so (a partial state)', async () => {
    const world = readyWorld()
    world.objects.delete('table|"public"."users"')
    mountApp(`${SCHEMA}/visualizer`, world)
    await search('r')
    await waitFor(() => expect(screen.getByTestId('erd')).toHaveAttribute('data-state', 'partial'))
    // orders points at users, which was not read: the foreign key is counted, not dropped.
    expect(await screen.findByText(/1 foreign keys are not drawn/)).toBeInTheDocument()
  })

  it('hands a failed list read to the diagram as a failure, never as an empty drawing', async () => {
    const world = readyWorld()
    world.failures.set('/schema/objects?', {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'The list is down.',
    })
    mountApp(`${SCHEMA}/visualizer`, world)
    await search('r')
    await waitFor(() => expect(screen.getByTestId('erd')).toHaveAttribute('data-state', 'failed'))
  })
})

describe('accessibility', () => {
  it('has no axe violations on the schema page', async () => {
    mountApp(SCHEMA, readyWorld())
    await screen.findByRole('table', { name: /Schemas with the number of objects/ })
    await screen.findByText(`sha256:fp1:${'ab'.repeat(32)}`)
    expect(await axeViolations(document.body)).toEqual([])
  })

  it('has no axe violations on a list with an open object', async () => {
    mountApp(`${SCHEMA}/tables`, readyWorld())
    const user = await search('ord')
    const table = await screen.findByRole('table', { name: 'Schema objects' })
    await user.click(within(table).getByRole('button', { name: 'orders' }))
    await waitFor(() =>
      expect(document.querySelector('[data-slot="object-detail"]')).not.toBeNull(),
    )
    expect(await axeViolations(document.body)).toEqual([])
  })

  it('has no axe violations on a paged list and on policies grouped by table', async () => {
    const world = readyWorld()
    world.objectsPageSize = 1
    mountApp(`${SCHEMA}/tables`, world)
    await screen.findByRole('button', { name: 'Load more objects' })
    expect(await axeViolations(document.body)).toEqual([])
    cleanup()
    const policies = readyWorld()
    policies.refs = [
      ref({
        kind: 'policy',
        name: 'own_rows',
        parent: 'orders',
        key: ['public', 'orders', 'own_rows'],
      }),
    ]
    mountApp(`${SCHEMA}/policies`, policies)
    await screen.findByRole('table', { name: 'Schema objects' })
    expect(await axeViolations(document.body)).toEqual([])
  })

  it('has no axe violations when the reads failed', async () => {
    const world = readyWorld()
    world.failures.set('/findings', { status: 500, code: 'INTERNAL_ERROR' })
    world.failures.set('/schema/fingerprint', { status: 500, code: 'INTERNAL_ERROR' })
    mountApp(SCHEMA, world)
    await screen.findAllByRole('alert')
    expect(await axeViolations(document.body)).toEqual([])
  })
})
