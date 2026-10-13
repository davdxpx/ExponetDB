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

  it('says a database without schemas has none only after a successful read', async () => {
    const world = readyWorld()
    world.overview = overviewFixture({ schemas: [] })
    mountApp(SCHEMA, world)
    expect(await screen.findByText('The read succeeded and found no schema.')).toBeInTheDocument()
  })
})

describe('the object lists', () => {
  it('lists nothing and asks for nothing until a name filter is applied', async () => {
    const world = readyWorld()
    mountApp(`${SCHEMA}/tables`, world)
    expect(await screen.findByText(/Enter part of a name to list objects/)).toBeInTheDocument()
    expect(world.requests.some((r) => r.includes('/schema/search'))).toBe(false)
    expect(screen.queryByText(/found no object/)).toBeNull()
  })

  it('searches by the kinds of the page and lists the matches', async () => {
    const world = readyWorld()
    mountApp(`${SCHEMA}/tables`, world)
    await search('ord')
    const table = await screen.findByRole('table', { name: 'Objects that match the filter' })
    expect(within(table).getByRole('button', { name: 'orders' })).toBeInTheDocument()
    expect(within(table).queryByText('users')).toBeNull()
    const request = world.requests.find((r) => r.includes('/schema/search')) ?? ''
    expect(request).toContain('q=ord')
    expect(request).toContain('kinds=table')
  })

  it('says "found no object" only after a successful empty read', async () => {
    mountApp(`${SCHEMA}/tables`, readyWorld())
    await search('zzz')
    expect(
      await screen.findByText('The read succeeded and found no object with that name.'),
    ).toBeInTheDocument()
  })

  it('shows a failed search as failed, never as an empty list', async () => {
    const world = readyWorld()
    world.failures.set('/schema/search', {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Search is down.',
    })
    mountApp(`${SCHEMA}/tables`, world)
    await search('ord')
    expect(await screen.findByText(/Search is down\./)).toBeInTheDocument()
    expect(screen.queryByText(/found no object/)).toBeNull()
    expect(screen.queryByRole('table', { name: 'Objects that match the filter' })).toBeNull()
  })

  it('says more match than one page shows, and offers to load more', async () => {
    const world = readyWorld()
    world.searchNext = 'next'
    mountApp(`${SCHEMA}/tables`, world)
    await search('ord')
    expect(await screen.findByText(/More objects match than one page shows/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Load more objects' })).toBeInTheDocument()
  })

  it('shows the details of an object: structure, flags, size, grants', async () => {
    const world = readyWorld()
    mountApp(`${SCHEMA}/tables`, world)
    const user = await search('ord')
    const table = await screen.findByRole('table', { name: 'Objects that match the filter' })
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
    const table = await screen.findByRole('table', { name: 'Objects that match the filter' })
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

  it('filters the matches by schema', async () => {
    const world = readyWorld()
    world.refs = [
      ref({ name: 'orders', schema: 'public' }),
      ref({ name: 'orders_log', schema: 'exponetdb', key: ['exponetdb', 'orders_log'] }),
    ]
    mountApp(`${SCHEMA}/tables`, world)
    const user = await search('ord')
    await screen.findByRole('table', { name: 'Objects that match the filter' })
    await user.click(screen.getByRole('button', { name: 'exponetdb' }))
    const table = screen.getByRole('table', { name: 'Objects that match the filter' })
    expect(
      within(table)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['orders_log'])
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
    const table = await screen.findByRole('table', { name: 'Objects that match the filter' })
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
  it('lists the classes of a schema and says a class cannot list without a filter (not that it is empty)', async () => {
    const user = userEvent.setup()
    mountApp(SCHEMA, readyWorld())
    const tree = await screen.findByRole('tree', { name: 'Schemas and their objects' })
    await user.click(within(tree).getByText('public'))
    const publicItem = within(tree).getByRole('treeitem', { name: /public/ })
    await user.click(within(publicItem).getByText('Tables'))
    expect(
      await within(tree).findByText(/Enter part of a name above and open this class again/),
    ).toBeInTheDocument()
    expect(within(tree).queryByText(/found no/i)).toBeNull()
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
    const request = world.requests.find((r) => r.includes('/schema/search')) ?? ''
    expect(request).toContain('kinds=table')
    expect(request).toContain('limit=200')
  })

  it('shows a class that failed to load as failed, with a retry, not as empty', async () => {
    const user = userEvent.setup()
    const world = readyWorld()
    world.failures.set('/schema/search', {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Search is down.',
    })
    mountApp(SCHEMA, world)
    await applyFilter(user, 'ord')
    const tree = await openTables(user)
    expect(await within(tree).findByText(/Search is down\./)).toBeInTheDocument()
    expect(within(tree).getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(within(tree).queryByText(/found no/i)).toBeNull()
  })
})

describe('the diagram', () => {
  it('loads the diagram chunk on demand and draws the tables with their foreign keys', async () => {
    const world = readyWorld()
    mountApp(`${SCHEMA}/visualizer`, world)
    expect(
      await screen.findByText(/Enter part of a table name to draw the matching tables/),
    ).toBeInTheDocument()
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

  it('hands a failed search to the diagram as a failure, never as an empty drawing', async () => {
    const world = readyWorld()
    world.failures.set('/schema/search', {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Search is down.',
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
    const table = await screen.findByRole('table', { name: 'Objects that match the filter' })
    await user.click(within(table).getByRole('button', { name: 'orders' }))
    await waitFor(() =>
      expect(document.querySelector('[data-slot="object-detail"]')).not.toBeNull(),
    )
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
