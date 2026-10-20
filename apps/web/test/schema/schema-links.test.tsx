import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { objectHref, type SchemaSearch } from '../../src/features/schema/search.ts'
import { parseSqlLink } from '../../src/features/sql/sql-model.ts'
import {
  BIDI,
  BrowseWorld,
  fingerprintFixture,
  mountBrowse,
  objectFixture,
  ordersObject,
  overviewFixture,
  project,
  ref,
  ZWSP,
} from './browse-support.tsx'

// The target pages run in the shortcut and command providers of the real shell, without the rail.
vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

// The diagram is a lazy chunk; the test replaces it and shows what it was given.
const drawn = vi.hoisted(() => ({ last: undefined as unknown }))
vi.mock('@exponetdb/ui-data/erd/schema-erd', () => ({
  SchemaErd: (props: {
    readable: {
      state: string
      value?: { tables: { schema: string; name: string }[]; relations: unknown[] }
    }
  }) => {
    drawn.last = props.readable
    const value = props.readable.value
    return createElement(
      'div',
      { 'data-testid': 'erd', 'data-state': props.readable.state },
      value === undefined
        ? props.readable.state
        : `${value.tables.length} tables, ${value.relations.length} relations: ${value.tables
            .map((table) => `${table.schema}.${table.name}`)
            .join(', ')}`,
    )
  },
}))

afterEach(() => {
  cleanup()
  drawn.last = undefined
  vi.restoreAllMocks()
})

const STAGING = 'shop/platform/staging'
const TARGET = { product: 'shop', project: 'platform', environment: 'staging' }
const SCHEMA = '/t/shop/platform/staging/schema'

function world(): BrowseWorld {
  const w = new BrowseWorld()
  project(w)
  w.sample(STAGING)
  w.sample('shop/platform/production')
  w.overview = overviewFixture()
  w.fingerprint = fingerprintFixture()
  w.permissions = ['data.read']
  const orders = ref({ name: 'orders' })
  const users = ref({ name: 'users' })
  w.refs = [orders, users]
  w.objects.set('table|"public"."orders"', ordersObject())
  w.objects.set(
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
  return w
}

/**
 * Replaces the clipboard after `userEvent.setup()` (which installs its own stub) with a spy, and
 * gives the document the focus the clipboard write needs.
 */
function stubClipboard(rejects = false) {
  const writeText = vi.fn(async () => {
    if (rejects) throw new Error('denied')
  })
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  return writeText
}

function link(key: readonly string[], kind = 'table', extra: Partial<SchemaSearch> = {}): string {
  const href = objectHref(TARGET, { kind, key }, extra)
  if (href === undefined) throw new Error('no link')
  return href
}

async function detail(): Promise<HTMLElement> {
  return waitFor(() => {
    const el = document.querySelector('[data-slot="object-detail"]')
    if (el === null) throw new Error('no detail yet')
    return el as HTMLElement
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

describe('a link carries the object, the filter and the schema', () => {
  it('opens the object of a link without the list that found it, and reads no search', async () => {
    const w = world()
    mountBrowse(link(['public', 'orders']), w)
    const panel = await detail()
    expect(within(panel).getByRole('table', { name: 'Columns' })).toBeInTheDocument()
    expect(screen.getByText(/Enter part of a name to list objects/)).toBeInTheDocument()
    expect(w.requests.some((r) => r.includes('/schema/search'))).toBe(false)
    expect(
      w.requests.some((r) => r.includes('/schema/objects/table/%22public%22.%22orders%22')),
    ).toBe(true)
  })

  it('writes a selected object into the link, and the back button returns to the list', async () => {
    const w = world()
    const { router } = mountBrowse(`${SCHEMA}/tables`, w)
    const user = await search('ord')
    const table = await screen.findByRole('table', { name: 'Objects that match the filter' })
    await user.click(within(table).getByRole('button', { name: 'orders' }))
    await detail()
    expect(router.state.location.search).toMatchObject({
      q: 'ord',
      object: ['table', 'public', 'orders'],
    })
    // Names travel in the search, never in the path.
    expect(router.state.location.pathname).toBe(`${SCHEMA}/tables`)
    router.history.back()
    await waitFor(() => expect(document.querySelector('[data-slot="object-detail"]')).toBeNull())
    expect(router.state.location.search.object).toBeUndefined()
    // Pressing the same name again closes it.
    await user.click(within(table).getByRole('button', { name: 'orders' }))
    await detail()
    await user.click(within(table).getByRole('button', { name: 'orders' }))
    await waitFor(() => expect(document.querySelector('[data-slot="object-detail"]')).toBeNull())
  })

  it('keeps the name filter and the schema in the link, and reads the list from them', async () => {
    const w = world()
    mountBrowse(`${SCHEMA}/tables?q=ord&schema=public`, w)
    const table = await screen.findByRole('table', { name: 'Objects that match the filter' })
    expect(within(table).getByRole('button', { name: 'orders' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Filter by name' })).toHaveValue('ord')
    expect(screen.getByRole('combobox', { name: /Schema public/ })).toBeInTheDocument()
    const request = w.requests.find((r) => r.includes('/schema/search')) ?? ''
    expect(request).toContain('q=ord')
  })

  it('applies a new filter to the link, and drops the object of the old one', async () => {
    const w = world()
    const { router } = mountBrowse(link(['public', 'orders'], 'table', { q: 'ord' }), w)
    await detail()
    const user = await search('use')
    await waitFor(() => expect(router.state.location.search.q).toBe('use'))
    expect(router.state.location.search.object).toBeUndefined()
    expect(document.querySelector('[data-slot="object-detail"]')).toBeNull()
    expect(user).toBeDefined()
  })

  it('starts the next object clean: its own tab, sort and filters', async () => {
    const w = world()
    const { router } = mountBrowse(
      link(['public', 'orders'], 'table', {
        q: 'r',
        tab: 'rows',
        sort: 'status',
        filter: [['status', '=', 'paid']],
      }),
      w,
    )
    await screen.findByRole('button', { name: 'Read rows' })
    const table = await screen.findByRole('table', { name: 'Objects that match the filter' })
    const user = userEvent.setup()
    await user.click(within(table).getByRole('button', { name: 'users' }))
    await waitFor(() =>
      expect(router.state.location.search.object).toEqual(['table', 'public', 'users']),
    )
    const search = router.state.location.search
    expect(search.tab).toBeUndefined()
    expect(search.sort).toBeUndefined()
    expect(search.filter).toBeUndefined()
    expect(search.q).toBe('r')
  })

  it('ignores hostile parameters: nothing is read, nothing is shown', async () => {
    const w = world()
    const hostile = [
      `q=${encodeURIComponent(`a${BIDI}b`)}`,
      `object=${encodeURIComponent('["Table","public","orders"]')}`,
      `object=${encodeURIComponent('"table.public.orders"')}`,
      'tab=evil',
      'sort=x&dir=sideways',
      `filter=${encodeURIComponent('[["status","; DROP TABLE x","1"]]')}`,
      `schema=${encodeURIComponent('a\u0000b')}`,
    ].join('&')
    const { router } = mountBrowse(`${SCHEMA}/tables?${hostile}`, w)
    expect(await screen.findByText(/Enter part of a name to list objects/)).toBeInTheDocument()
    expect(document.querySelector('[data-slot="object-detail"]')).toBeNull()
    expect(
      w.requests.some((r) => r.includes('/schema/search') || r.includes('/schema/objects')),
    ).toBe(false)
    expect(w.runs()).toHaveLength(0)
    expect(router.state.location.search.object).toBeUndefined()
    expect(router.state.location.search.q).toBeUndefined()
  })

  it('shows an object that cannot be read as failed, with the code, not as empty details', async () => {
    const w = world()
    w.objects.clear()
    mountBrowse(link(['public', 'orders']), w)
    expect(
      await screen.findByText(/This does not mean there is no object details/),
    ).toBeInTheDocument()
    expect(document.querySelector('[data-slot="object-detail"]')).toBeNull()
  })
})

describe('copying a name and a link', () => {
  it('copies the quoted qualified name', async () => {
    mountBrowse(link(['public', 'orders']), world())
    const panel = await detail()
    const user = userEvent.setup()
    const writeText = stubClipboard()
    await user.click(within(panel).getByRole('button', { name: 'Copy name' }))
    expect(writeText).toHaveBeenCalledWith('"public"."orders"')
    expect(await within(panel).findByText('Copied the name.')).toBeInTheDocument()
  })

  it('copies a hostile name quoted, as one identifier', async () => {
    const w = world()
    const name = 'a"; DROP TABLE x; --'
    w.objects.set(
      `table|"public"."${name.replaceAll('"', '""')}"`,
      objectFixture(ref({ name, key: ['public', name] }), { columns: [], constraints: [] }),
    )
    mountBrowse(link(['public', name]), w)
    const panel = await detail()
    const user = userEvent.setup()
    const writeText = stubClipboard()
    await user.click(within(panel).getByRole('button', { name: 'Copy name' }))
    expect(writeText).toHaveBeenCalledWith('"public"."a""; DROP TABLE x; --"')
  })

  it('copies a link to the object with its tab and filters, whole, with no name in the path', async () => {
    mountBrowse(
      link(['public', 'orders'], 'table', {
        tab: 'rows',
        sort: 'status',
        dir: 'desc',
        filter: [['status', '=', 'paid']],
      }),
      world(),
    )
    const panel = await detail()
    const user = userEvent.setup()
    const writeText = stubClipboard()
    await user.click(within(panel).getByRole('button', { name: 'Copy link' }))
    const copied = String((writeText.mock.calls[0] as unknown[] | undefined)?.[0])
    const url = new URL(copied)
    expect(url.origin).toBe(window.location.origin)
    expect(url.pathname).toBe(`${SCHEMA}/tables`)
    expect(copied).not.toContain('/orders')
    expect(JSON.parse(url.searchParams.get('object') ?? 'null')).toEqual([
      'table',
      'public',
      'orders',
    ])
    expect(url.searchParams.get('tab')).toBe('rows')
    expect(url.searchParams.get('sort')).toBe('status')
    expect(url.searchParams.get('dir')).toBe('desc')
    expect(JSON.parse(url.searchParams.get('filter') ?? 'null')).toEqual([['status', '=', 'paid']])
    expect(within(panel).getByText('Copied the link.')).toBeInTheDocument()
  })

  it('says it could not copy when the clipboard refuses, instead of saying it did', async () => {
    mountBrowse(link(['public', 'orders']), world())
    const panel = await detail()
    const user = userEvent.setup()
    stubClipboard(true)
    await user.click(within(panel).getByRole('button', { name: 'Copy name' }))
    expect(await within(panel).findByText(/Could not copy to the clipboard/)).toBeInTheDocument()
    expect(within(panel).queryByText('Copied the name.')).toBeNull()
  })
})

describe('Open in SQL, Query this table and Draft a change', () => {
  it('opens a query on the table in a new tab of the SQL page, and never runs it', async () => {
    const w = world()
    mountBrowse(link(['public', 'orders']), w)
    const panel = await detail()
    const query = within(panel).getByRole('link', { name: 'Query this table' })
    const href = query.getAttribute('href') ?? ''
    expect(href.startsWith('/t/shop/platform/staging/sql?')).toBe(true)
    expect(parseSqlLink(href.slice(href.indexOf('?'))).sql).toEqual({
      kind: 'text',
      sql: 'SELECT * FROM "public"."orders" LIMIT 100',
    })
    expect(w.runs()).toHaveLength(0)
    expect(
      within(panel).getByRole('link', { name: 'Draft a change to this object' }),
    ).toHaveAttribute('href', '/t/shop/platform/staging/sql?mode=draft')
  })

  it('quotes a hostile table name in the query it opens', async () => {
    const w = world()
    const name = `a"; DROP TABLE x; --${BIDI}`
    w.objects.set(
      `table|"public"."${name.replaceAll('"', '""')}"`,
      objectFixture(ref({ name, key: ['public', name] }), { columns: [], constraints: [] }),
    )
    mountBrowse(link(['public', name]), w)
    const panel = await detail()
    const href =
      within(panel).getByRole('link', { name: 'Query this table' }).getAttribute('href') ?? ''
    const sql = parseSqlLink(href.slice(href.indexOf('?'))).sql
    expect(sql).toEqual({
      kind: 'text',
      sql: `SELECT * FROM "public"."a""; DROP TABLE x; --${BIDI}" LIMIT 100`,
    })
    expect(href).not.toContain(BIDI)
  })

  it('opens the definition of a view as a query and of a function as a draft', async () => {
    const w = world()
    const view = ref({ kind: 'view', name: 'v', key: ['public', 'v'] })
    w.objects.set(
      'view|"public"."v"',
      objectFixture(view, { definition: ' SELECT id FROM public.orders;', columns: [] }),
    )
    const fn = ref({ kind: 'function', name: 'f', signature: '', key: ['public', 'f', ''] })
    w.objects.set(
      'function|"public"."f"()',
      objectFixture(fn, {
        definition:
          'CREATE OR REPLACE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$',
      }),
    )
    mountBrowse(link(['public', 'v'], 'view'), w)
    let panel = await detail()
    const viewHref =
      within(panel)
        .getByRole('link', { name: 'Open definition in SQL editor' })
        .getAttribute('href') ?? ''
    expect(parseSqlLink(viewHref.slice(viewHref.indexOf('?')))).toEqual({
      mode: undefined,
      sql: { kind: 'text', sql: ' SELECT id FROM public.orders;' },
    })
    expect(within(panel).getByRole('link', { name: 'Query this view' })).toBeInTheDocument()
    cleanup()
    mountBrowse(link(['public', 'f', ''], 'function'), w)
    panel = await detail()
    const fnHref =
      within(panel)
        .getByRole('link', { name: 'Open definition in SQL editor' })
        .getAttribute('href') ?? ''
    expect(parseSqlLink(fnHref.slice(fnHref.indexOf('?'))).mode).toBe('draft')
    expect(within(panel).queryByRole('link', { name: /^Query this/ })).toBeNull()
  })

  it('offers no link for a definition the SQL page would not open, and says why', async () => {
    const w = world()
    const fn = ref({ kind: 'function', name: 'big', signature: '', key: ['public', 'big', ''] })
    w.objects.set(
      'function|"public"."big"()',
      objectFixture(fn, { definition: `CREATE FUNCTION big() ${'x'.repeat(17_000)}` }),
    )
    mountBrowse(link(['public', 'big', ''], 'function'), w)
    const panel = await detail()
    expect(within(panel).queryByRole('link', { name: 'Open definition in SQL editor' })).toBeNull()
    expect(panel.querySelector('[data-slot="definition-too-long"]')?.textContent).toContain(
      'too long to open from a link',
    )
  })

  it('has no action that changes the database', async () => {
    mountBrowse(link(['public', 'orders']), world())
    const panel = await detail()
    const labels = [
      ...within(panel)
        .getAllByRole('button')
        .map((b) => b.textContent ?? ''),
      ...within(panel)
        .getAllByRole('link')
        .map((a) => a.textContent ?? ''),
    ].join('|')
    expect(labels).not.toMatch(/\b(drop|alter|execute|apply|delete|insert)\b/i)
  })
})

describe('key tokens and the jump along a foreign key', () => {
  it('marks the primary key, the unique column and the foreign key', async () => {
    mountBrowse(link(['public', 'orders']), world())
    const panel = await detail()
    const columns = within(panel).getByRole('table', { name: 'Columns' })
    const row = (name: string) =>
      within(columns)
        .getAllByRole('row')
        .find(
          (r) => within(r).queryByText(name, { selector: '[data-untrusted="name"] span' }) !== null,
        ) as HTMLElement
    expect(within(columns).getByRole('columnheader', { name: 'Keys' })).toBeInTheDocument()
    expect(row('id')).toHaveTextContent('PK Primary key')
    expect(row('status')).toHaveTextContent('UQ Unique')
    expect(row('user_id')).toHaveTextContent('FK References')
    expect(row('total')).toHaveTextContent('None')
  })

  it('links a foreign key to the detail of the table it references', async () => {
    const w = world()
    const { router } = mountBrowse(link(['public', 'orders']), w)
    const panel = await detail()
    const jump = within(panel).getByRole('link', { name: 'public.users (id)' })
    expect(jump).toHaveAttribute(
      'href',
      `${SCHEMA}/tables?object=${encodeURIComponent('["table","public","users"]')}`,
    )
    await userEvent.setup().click(jump)
    await waitFor(() =>
      expect(router.state.location.search.object).toEqual(['table', 'public', 'users']),
    )
    await waitFor(() =>
      expect(
        w.requests.some((r) => r.includes('/schema/objects/table/%22public%22.%22users%22')),
      ).toBe(true),
    )
    await waitFor(() => {
      const names = [...document.querySelectorAll('[data-slot="object-detail"]')]
      expect(names).toHaveLength(1)
      expect(names[0]?.textContent).toContain('users_pk')
    })
  })

  it('shows a hostile referenced name as text, and the link stays inside the app', async () => {
    const w = world()
    const target = `x${BIDI}"y`
    w.objects.set(
      'table|"public"."orders"',
      ordersObject({
        constraints: [
          {
            name: 'fk',
            type: 'foreign_key',
            definition: `FOREIGN KEY (user_id) REFERENCES "evil${ZWSP}schema"."${target.replaceAll('"', '""')}"(id)`,
            validated: true,
          },
        ],
      }),
    )
    mountBrowse(link(['public', 'orders']), w)
    const panel = await detail()
    const tokens = panel.querySelector('[data-slot="foreign-key"]') as HTMLElement
    expect(tokens.textContent).toContain('⟨U+200B⟩')
    expect(tokens.textContent).toContain('⟨U+202E⟩')
    expect(tokens.textContent).not.toContain(BIDI)
    const anchor = tokens.querySelector('a')
    expect(anchor?.getAttribute('href')).toMatch(
      /^\/t\/shop\/platform\/staging\/schema\/tables\?object=/,
    )
    expect(anchor?.getAttribute('href')).not.toContain(BIDI)
  })

  it('has no Keys column for a view, whose read lists no constraint', async () => {
    const w = world()
    const view = ref({ kind: 'view', name: 'v', key: ['public', 'v'] })
    w.objects.set(
      'view|"public"."v"',
      objectFixture(view, {
        columns: [
          {
            name: 'id',
            type: 'uuid',
            nullable: true,
            default: null,
            generated: null,
            identity: null,
          },
        ],
      }),
    )
    mountBrowse(link(['public', 'v'], 'view'), w)
    const panel = await detail()
    expect(within(panel).queryByRole('columnheader', { name: 'Keys' })).toBeNull()
    // A view can still be browsed.
    expect(within(panel).getByRole('tab', { name: 'Browse rows' })).toBeInTheDocument()
  })

  it('offers the row browser for tables, views and materialized views, and for no other kind', async () => {
    const w = world()
    const index = ref({ kind: 'index', name: 'i', key: ['public', 'i'] })
    w.objects.set('index|"public"."i"', objectFixture(index, {}))
    mountBrowse(link(['public', 'i'], 'index'), w)
    const panel = await detail()
    expect(within(panel).queryByRole('tab', { name: 'Browse rows' })).toBeNull()
    cleanup()
    mountBrowse(link(['public', 'orders']), w)
    expect(await screen.findByRole('tab', { name: 'Browse rows' })).toBeInTheDocument()
  })
})

describe('the schema selector', () => {
  function schemasWorld(): BrowseWorld {
    const w = world()
    w.overview = overviewFixture({
      schemas: [
        { name: 'public', managed: false, objectCounts: { table: 2 } },
        { name: 'exponetdb', managed: true, objectCounts: { table: 4 } },
        { name: 'audit', managed: false, objectCounts: { table: 1 } },
        { name: 'ops', managed: true, objectCounts: { table: 1 } },
        { name: `s${BIDI}x`, managed: false, objectCounts: { table: 1 } },
      ],
    })
    w.refs = [
      ref({ name: 'orders', schema: 'public' }),
      ref({ name: 'orders_log', schema: 'exponetdb', key: ['exponetdb', 'orders_log'] }),
    ]
    return w
  }

  it('lists the schemas managed by ExponetDB first, then the others, each group by name', async () => {
    mountBrowse(`${SCHEMA}/tables?q=ord`, schemasWorld())
    const user = userEvent.setup()
    await user.click(await screen.findByRole('combobox', { name: /Schema/ }))
    const list = await screen.findByRole('listbox')
    // "All schemas", the managed group and the others.
    expect(within(list).getAllByRole('group')).toHaveLength(3)
    const text = list.textContent ?? ''
    expect(text.indexOf('Managed by ExponetDB')).toBeLessThan(text.indexOf('Other schemas'))
    expect(text.indexOf('exponetdb')).toBeLessThan(text.indexOf('ops'))
    expect(text.indexOf('ops')).toBeLessThan(text.indexOf('Other schemas'))
    expect(text.indexOf('audit')).toBeLessThan(text.indexOf('public'))
    expect(within(list).getByRole('option', { name: 'All schemas' })).toBeInTheDocument()
  })

  it('narrows the list as you type, chooses a schema and keeps it in the link', async () => {
    const w = schemasWorld()
    const { router } = mountBrowse(`${SCHEMA}/tables?q=ord`, w)
    const user = userEvent.setup()
    const table = await screen.findByRole('table', { name: 'Objects that match the filter' })
    expect(within(table).getAllByRole('button')).toHaveLength(2)
    await user.click(screen.getByRole('combobox', { name: /Schema/ }))
    await user.type(await screen.findByPlaceholderText('Search schemas'), 'EXPO')
    const options = await screen.findAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['exponetdb'])
    await user.click(options[0] as HTMLElement)
    await waitFor(() => expect(router.state.location.search.schema).toBe('exponetdb'))
    expect(
      within(screen.getByRole('table', { name: 'Objects that match the filter' }))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['orders_log'])
    // Choosing "All schemas" clears it again.
    await user.click(screen.getByRole('combobox', { name: /Schema/ }))
    await user.click(await screen.findByRole('option', { name: 'All schemas' }))
    await waitFor(() => expect(router.state.location.search.schema).toBeUndefined())
  })

  it('says no schema matches, instead of showing an empty list', async () => {
    mountBrowse(`${SCHEMA}/tables?q=ord`, schemasWorld())
    const user = userEvent.setup()
    await user.click(await screen.findByRole('combobox', { name: /Schema/ }))
    await user.type(await screen.findByPlaceholderText('Search schemas'), 'zzz')
    expect(await screen.findByText('No schema matches.')).toBeInTheDocument()
  })

  it('chooses a schema by its place in the list, whatever characters its name holds', async () => {
    const w = schemasWorld()
    const { router } = mountBrowse(`${SCHEMA}/tables?q=ord`, w)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('combobox', { name: /Schema/ }))
    const option = await screen.findByRole('option', { name: /^s.*x$/ })
    expect(option.textContent).toContain('⟨U+202E⟩')
    expect(option.textContent).not.toContain(BIDI)
    await user.click(option)
    await waitFor(() => expect(router.state.location.search.schema).toBe(`s${BIDI}x`))
  })

  it('lists at most a hundred schemas and says how many more there are', async () => {
    const w = schemasWorld()
    w.overview = overviewFixture({
      schemas: Array.from({ length: 150 }, (_, n) => ({
        name: `s${String(n).padStart(3, '0')}`,
        managed: false,
        objectCounts: { table: 1 },
      })),
    })
    mountBrowse(`${SCHEMA}/tables?q=ord`, w)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('combobox', { name: /Schema/ }))
    await screen.findByRole('listbox')
    // 100 schemas and "All schemas".
    expect(screen.getAllByRole('option')).toHaveLength(101)
    expect(
      screen.getByText('Showing the first 100 of 150 schemas. Type to narrow the list.'),
    ).toBeInTheDocument()
  })

  it('says the selector is off, and why, when the list of schemas could not be read', async () => {
    const w = schemasWorld()
    w.failuresExact.set('/api/v1/targets/shop%2Fplatform%2Fstaging/schema', {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Inventory unavailable.',
    })
    mountBrowse(`${SCHEMA}/tables?q=ord`, w)
    expect(await screen.findByText(/The list of schemas could not be read/)).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: /Schema/ })).toBeNull()
    // The list itself still works.
    expect(
      await screen.findByRole('table', { name: 'Objects that match the filter' }),
    ).toBeInTheDocument()
  })
})

describe('the diagram: find a table and export', () => {
  function diagramWorld(): BrowseWorld {
    const w = world()
    const products = ref({ name: 'products' })
    w.refs = [...w.refs, products]
    w.objects.set(
      'table|"public"."products"',
      objectFixture(products, {
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
          { name: 'p_pk', type: 'primary_key', definition: 'PRIMARY KEY (id)', validated: true },
        ],
      }),
    )
    return w
  }

  async function drawnFor(term: string) {
    const user = await search(term)
    const erd = await screen.findByTestId('erd')
    await waitFor(() => expect(erd).toHaveAttribute('data-state', 'ready'))
    return { user, erd }
  }

  it('finds a table and shows it with the tables next to it, then all again', async () => {
    mountBrowse(`${SCHEMA}/visualizer`, diagramWorld())
    const { user, erd } = await drawnFor('r')
    expect(erd).toHaveTextContent('3 tables, 1 relations')
    await user.click(await screen.findByRole('combobox', { name: /Find a table/ }))
    await user.type(await screen.findByPlaceholderText('Search tables'), 'ORD')
    const options = await screen.findAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['public.orders'])
    await user.click(options[0] as HTMLElement)
    await waitFor(() =>
      expect(screen.getByTestId('erd')).toHaveTextContent('2 tables, 1 relations'),
    )
    expect(screen.getByTestId('erd')).toHaveTextContent('public.orders, public.users')
    expect(screen.getByTestId('erd').textContent).not.toContain('products')
    expect(document.querySelector('[data-slot="erd-focus"]')?.textContent).toContain(
      'The diagram shows it with its 1 connected tables',
    )
    await user.click(screen.getByRole('button', { name: 'Show all tables' }))
    await waitFor(() =>
      expect(screen.getByTestId('erd')).toHaveTextContent('3 tables, 1 relations'),
    )
    expect(document.querySelector('[data-slot="erd-focus"]')).toBeNull()
  })

  it('says no table matches when the search finds none', async () => {
    mountBrowse(`${SCHEMA}/visualizer`, diagramWorld())
    const { user } = await drawnFor('r')
    await user.click(await screen.findByRole('combobox', { name: /Find a table/ }))
    await user.type(await screen.findByPlaceholderText('Search tables'), 'zzz')
    expect(await screen.findByText('No table matches.')).toBeInTheDocument()
  })

  it('keeps the filter and the schema in the link', async () => {
    const { router } = mountBrowse(`${SCHEMA}/visualizer?q=r&schema=public`, diagramWorld())
    const erd = await screen.findByTestId('erd')
    await waitFor(() => expect(erd).toHaveAttribute('data-state', 'ready'))
    expect(
      screen.getByRole('textbox', { name: 'Draw the tables whose name contains' }),
    ).toHaveValue('r')
    expect(router.state.location.search).toMatchObject({ q: 'r', schema: 'public' })
  })

  describe('exports', () => {
    let saved: { name: string; type: string; text: Promise<string> }[]

    beforeEach(() => {
      saved = []
      URL.createObjectURL = vi.fn((blob: Blob) => {
        saved.push({ name: '', type: blob.type, text: blob.text() })
        return 'blob:exdb-test'
      })
      URL.revokeObjectURL = vi.fn()
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        const last = saved[saved.length - 1]
        if (last !== undefined) last.name = this.download
      })
    })

    it('downloads the drawing as an SVG file built from the read, with no remote font or foreignObject', async () => {
      mountBrowse(`${SCHEMA}/visualizer`, diagramWorld())
      const { user } = await drawnFor('r')
      await user.click(screen.getByRole('button', { name: 'Download as SVG' }))
      expect(saved).toHaveLength(1)
      expect(saved[0]?.type).toBe('image/svg+xml')
      expect(saved[0]?.name).toBe('schema-shop-platform-staging.svg')
      const svg = await (saved[0]?.text ?? Promise.resolve(''))
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      expect(doc.getElementsByTagName('parsererror')).toHaveLength(0)
      expect(doc.getElementsByTagName('g')).toHaveLength(3)
      expect(doc.documentElement.textContent).toContain('public.orders')
      expect(svg).not.toMatch(/foreignObject|https?:\/\/(?!www\.w3\.org)/)
      expect(
        await screen.findByText(/Downloaded the 3 tables drawn here as an SVG file/),
      ).toBeInTheDocument()
    })

    it('exports what is drawn: the focused table and its neighbors', async () => {
      mountBrowse(`${SCHEMA}/visualizer`, diagramWorld())
      const { user } = await drawnFor('r')
      await user.click(await screen.findByRole('combobox', { name: /Find a table/ }))
      await user.click(await screen.findByRole('option', { name: 'public.orders' }))
      await waitFor(() => expect(screen.getByTestId('erd')).toHaveTextContent('2 tables'))
      const writeText = stubClipboard()
      await user.click(screen.getByRole('button', { name: 'Copy as Markdown' }))
      const markdown = String((writeText.mock.calls[0] as unknown[] | undefined)?.[0])
      expect(markdown).toContain('## `public.orders`')
      expect(markdown).toContain('## `public.users`')
      expect(markdown).not.toContain('products')
      expect(markdown).toContain(
        '- `orders_user_fk`: `public.orders` (`user_id`) -> `public.users` (`id`)',
      )
      expect(
        await screen.findByText(/Copied the 2 tables drawn here as Markdown/),
      ).toBeInTheDocument()
    })

    it('says it could not copy when the clipboard refuses', async () => {
      mountBrowse(`${SCHEMA}/visualizer`, diagramWorld())
      const { user } = await drawnFor('r')
      stubClipboard(true)
      await user.click(screen.getByRole('button', { name: 'Copy as Markdown' }))
      expect(
        await screen.findByText(/Could not copy to the clipboard\. Download the SVG instead/),
      ).toBeInTheDocument()
    })

    it('says in the export what the read left out', async () => {
      const w = diagramWorld()
      // A table whose foreign key points outside the read: counted, not drawn.
      w.objects.delete('table|"public"."users"')
      mountBrowse(`${SCHEMA}/visualizer`, w)
      const user = await search('r')
      await waitFor(() =>
        expect(screen.getByTestId('erd')).toHaveAttribute('data-state', 'partial'),
      )
      const writeText = stubClipboard()
      await user.click(screen.getByRole('button', { name: 'Copy as Markdown' }))
      expect(String((writeText.mock.calls[0] as unknown[] | undefined)?.[0])).toContain(
        'foreign keys were not included',
      )
    })
  })

  it('has no export tools while the tables are loading or when the search failed', async () => {
    const w = diagramWorld()
    w.failures.set('/schema/search', {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Search is down.',
    })
    mountBrowse(`${SCHEMA}/visualizer`, w)
    await search('r')
    await waitFor(() => expect(screen.getByTestId('erd')).toHaveAttribute('data-state', 'failed'))
    expect(screen.queryByRole('button', { name: 'Download as SVG' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: /Find a table/ })).toBeNull()
  })
})

describe('the tree', () => {
  it('gives an object picked in the tree the same actions and the Rows tab, idle', async () => {
    const w = world()
    mountBrowse(SCHEMA, w)
    const user = userEvent.setup()
    const box = await screen.findByRole('textbox', { name: 'Filter the tree by name' })
    await user.type(box, 'ord')
    await user.click(screen.getByRole('button', { name: 'Show matching objects' }))
    const tree = await screen.findByRole('tree', { name: 'Schemas and their objects' })
    await user.click(within(tree).getByText('public'))
    const publicItem = within(tree).getByRole('treeitem', { name: /public/ })
    await user.click(within(publicItem).getByText('Tables'))
    await user.click(await within(tree).findByText('orders'))
    const panel = await waitFor(() => {
      const el = document.querySelector('[data-slot="tree-object"]')
      if (el === null) throw new Error('no panel yet')
      return el as HTMLElement
    })
    expect(await within(panel).findByRole('button', { name: 'Copy link' })).toBeInTheDocument()
    await user.click(within(panel).getByRole('tab', { name: 'Browse rows' }))
    expect(await within(panel).findByRole('button', { name: 'Read rows' })).toBeEnabled()
    expect(w.runs()).toHaveLength(0)
  })
})

describe('accessibility', () => {
  it('has no axe violations on an open object with its actions and key tokens', async () => {
    mountBrowse(link(['public', 'orders']), world())
    await detail()
    expect(await axeViolations(document.body)).toEqual([])
  })

  it('has no axe violations on the open schema selector', async () => {
    mountBrowse(`${SCHEMA}/tables?q=ord`, world())
    const user = userEvent.setup()
    await user.click(await screen.findByRole('combobox', { name: /Schema/ }))
    await screen.findByRole('listbox')
    expect(await axeViolations(document.body)).toEqual([])
  })

  it('has no axe violations on the diagram tools', async () => {
    mountBrowse(`${SCHEMA}/visualizer`, world())
    await search('r')
    await screen.findByRole('button', { name: 'Download as SVG' })
    expect(await axeViolations(document.body)).toEqual([])
  })
})
