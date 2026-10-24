import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { bodyOf, clearStorage, editor, SQL, STAGING, type, world } from './helpers.tsx'
import { BIDI, mountSql, type SqlWorld, savedFixture } from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))
vi.mock('@exponetdb/ui-data/editor/sql-editor', async () =>
  (await import('./stand-ins.tsx')).editorModule(),
)
vi.mock('@exponetdb/ui-data/grid/data-grid', async () =>
  (await import('./stand-ins.tsx')).gridModule(),
)

beforeEach(clearStorage)
afterEach(cleanup)

const ID = 'sqy_01M4V3RV9F5XM2TB8KC6QZJ0NS'
const OTHER = 'sqy_01M4V3RV9F5XM2TB8KC6QZJ0N2'
const STORED_SQL = 'SELECT id FROM public.orders'

function listWith(w: SqlWorld, items: ReturnType<typeof savedFixture>[]): void {
  w.saved = { status: 200, body: { items, nextCursor: null } }
  w.getSaved = (id) => ({
    status: 200,
    body: items.find((item) => item.id === id) ?? savedFixture({ id }),
  })
}

function item(id = ID): HTMLElement {
  const found = document.querySelector(`[data-saved="${id}"]`)
  if (found === null) throw new Error(`no saved item ${id}`)
  return found as HTMLElement
}

async function itemFor(id = ID): Promise<HTMLElement> {
  return await waitFor(() => item(id))
}

async function openMenu(
  user: ReturnType<typeof userEvent.setup>,
  within_: HTMLElement,
): Promise<HTMLElement> {
  await user.click(within(within_).getByRole('button', { name: 'Actions' }))
  return await screen.findByRole('menu')
}

function puts(w: SqlWorld) {
  return w.calls('PUT', '/saved-queries/')
}

describe('the actions on a saved query in the side panel', () => {
  it('are offered to the owner and to nobody else', async () => {
    const w = world()
    listWith(w, [
      savedFixture({ id: ID, ownedByCaller: true }),
      savedFixture({ id: OTHER, name: 'Theirs', ownedByCaller: false }),
    ])
    mountSql(SQL, w)
    await editor()
    expect(within(await itemFor(ID)).getByRole('button', { name: 'Actions' })).toBeInTheDocument()
    expect(within(await itemFor(OTHER)).queryByRole('button', { name: 'Actions' })).toBeNull()
    expect(within(item(OTHER)).queryByRole('button', { name: 'Delete' })).toBeNull()
  })

  it('renames a saved query against the stored version and keeps its text and scope', async () => {
    const user = userEvent.setup()
    const w = world()
    listWith(w, [savedFixture({ id: ID, revision: 3, visibility: 'project' })])
    mountSql(SQL, w)
    await editor()
    const row = await itemFor()
    await openMenu(user, row)
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const dialog = await screen.findByRole('dialog', { name: 'Rename the saved query' })
    const name = within(dialog).getByLabelText('Name')
    expect(name).toHaveValue('Open orders')
    await user.clear(name)
    await user.type(name, 'Orders still open')
    await user.click(within(dialog).getByRole('button', { name: 'Rename saved query' }))
    await waitFor(() => expect(puts(w)).toHaveLength(1))
    expect(puts(w)[0]?.body).toEqual({
      name: 'Orders still open',
      sql: STORED_SQL,
      visibility: 'project',
      revision: 3,
    })
    expect(w.calls('GET', `/saved-queries/${ID}`)).toHaveLength(1)
    expect(await within(item()).findByRole('status')).toHaveTextContent(
      'Renamed. The saved query is at revision 4.',
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(w.calls('POST', '/queries')).toEqual([])
  })

  it('reads the list again after a change', async () => {
    const user = userEvent.setup()
    const w = world()
    listWith(w, [savedFixture({ id: ID })])
    mountSql(SQL, w)
    await editor()
    await itemFor()
    const reads = w.calls('GET', '/saved-queries?').length
    await openMenu(user, item())
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Name'), ' 2')
    await user.click(within(dialog).getByRole('button', { name: 'Rename saved query' }))
    await waitFor(() => expect(w.calls('GET', '/saved-queries?').length).toBeGreaterThan(reads))
  })

  it('never saves the edits of an open tab when the query is renamed', async () => {
    const user = userEvent.setup()
    const w = world()
    listWith(w, [savedFixture({ id: ID, revision: 3 })])
    mountSql(SQL, w)
    await editor()
    await user.click(within(await itemFor()).getByRole('button', { name: 'Open in a new tab' }))
    const area = await editor()
    type(area, 'SELECT id FROM public.orders WHERE edited')
    await openMenu(user, item())
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const dialog = await screen.findByRole('dialog')
    await user.clear(within(dialog).getByLabelText('Name'))
    await user.type(within(dialog).getByLabelText('Name'), 'Renamed')
    await user.click(within(dialog).getByRole('button', { name: 'Rename saved query' }))
    await waitFor(() => expect(puts(w)).toHaveLength(1))
    expect(puts(w)[0]?.body).toMatchObject({ sql: STORED_SQL, revision: 3 })
    // The tab keeps its text and follows the new name and revision.
    expect(area).toHaveValue('SELECT id FROM public.orders WHERE edited')
    await waitFor(() =>
      expect(
        document.querySelector('[data-origin="saved"][data-selected="true"]'),
      ).toHaveTextContent('Renamed'),
    )
    fireEvent.keyDown(document.body, { key: 's', ctrlKey: true })
    await waitFor(() => expect(puts(w)).toHaveLength(2))
    expect(puts(w)[1]?.body).toMatchObject({
      name: 'Renamed',
      sql: 'SELECT id FROM public.orders WHERE edited',
      revision: 4,
    })
  })

  it('follows the name rules of the save dialog: not empty, at most 120 characters', async () => {
    const user = userEvent.setup()
    const w = world()
    listWith(w, [savedFixture({ id: ID })])
    mountSql(SQL, w)
    await editor()
    await openMenu(user, await itemFor())
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const dialog = await screen.findByRole('dialog')
    const name = within(dialog).getByLabelText('Name')
    const submit = within(dialog).getByRole('button', { name: 'Rename saved query' })
    await user.clear(name)
    expect(submit).toBeDisabled()
    await user.type(name, '   ')
    expect(submit).toBeDisabled()
    fireEvent.change(name, { target: { value: 'x'.repeat(121) } })
    expect(submit).toBeDisabled()
    expect(within(dialog).getByText('The name is longer than 120 characters.')).toBeInTheDocument()
    expect(name).toHaveAttribute('aria-invalid', 'true')
    fireEvent.change(name, { target: { value: 'x'.repeat(120) } })
    expect(submit).toBeEnabled()
    expect(puts(w)).toEqual([])
  })

  it('shows a hostile name as text and writes it into the request as it was typed', async () => {
    const user = userEvent.setup()
    const w = world()
    listWith(w, [savedFixture({ id: ID, name: `<script>x</script> ${BIDI}orders` })])
    mountSql(SQL, w)
    await editor()
    const row = await itemFor()
    expect(row.textContent).toContain('<script>x</script>')
    expect(row.textContent).toMatch(/U\+202E/)
    expect(row.querySelector('script')).toBeNull()
    await openMenu(user, row)
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: '<img src=x onerror=alert(1)>' },
    })
    await user.click(within(dialog).getByRole('button', { name: 'Rename saved query' }))
    await waitFor(() => expect(puts(w)).toHaveLength(1))
    expect(bodyOf<{ name: string }>(puts(w)[0])?.name).toBe('<img src=x onerror=alert(1)>')
    expect(document.querySelector('img')).toBeNull()
  })

  it('changes who sees it with a radio choice that shows the current one', async () => {
    const user = userEvent.setup()
    const w = world()
    listWith(w, [savedFixture({ id: ID, revision: 2, visibility: 'personal' })])
    mountSql(SQL, w)
    await editor()
    const row = await itemFor()
    await openMenu(user, row)
    expect(screen.getByRole('menuitemradio', { name: 'Only me' })).toBeChecked()
    expect(screen.getByRole('menuitemradio', { name: 'Shared in scope' })).not.toBeChecked()
    await user.click(screen.getByRole('menuitemradio', { name: 'Shared in scope' }))
    await waitFor(() => expect(puts(w)).toHaveLength(1))
    expect(puts(w)[0]?.body).toEqual({
      name: 'Open orders',
      sql: STORED_SQL,
      visibility: 'project',
      revision: 2,
    })
    expect(await within(row).findByRole('status')).toHaveTextContent(
      'Everyone who may read data in its scope can see this saved query now. Revision 3.',
    )
  })

  it('sends nothing when the current choice is chosen again', async () => {
    const user = userEvent.setup()
    const w = world()
    listWith(w, [savedFixture({ id: ID, visibility: 'personal' })])
    mountSql(SQL, w)
    await editor()
    await openMenu(user, await itemFor())
    await user.click(screen.getByRole('menuitemradio', { name: 'Only me' }))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(puts(w)).toEqual([])
  })

  it('saves a copy of the stored text as a new query, prefilled like the original', async () => {
    const user = userEvent.setup()
    const w = world()
    listWith(w, [
      savedFixture({
        id: ID,
        visibility: 'project',
        scope: { kind: 'project', projectId: 'prj_00000000000000000000000001' },
      }),
    ])
    mountSql(SQL, w)
    await editor()
    await openMenu(user, await itemFor())
    await user.click(screen.getByRole('menuitem', { name: 'Save as copy' }))
    const dialog = await screen.findByRole('dialog', { name: 'Save a copy of the query' })
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Open orders (copy)')
    expect(
      within(dialog).getByRole('radio', { name: 'Everyone who may read data in its scope' }),
    ).toBeChecked()
    expect(within(dialog).getByRole('radio', { name: 'The whole project' })).toBeChecked()
    await user.click(within(dialog).getByRole('button', { name: 'Save copy' }))
    await waitFor(() => expect(w.calls('POST', '/saved-queries')).toHaveLength(1))
    expect(w.calls('POST', '/saved-queries')[0]?.body).toMatchObject({
      name: 'Open orders (copy)',
      sql: STORED_SQL,
      visibility: 'project',
      scope: { kind: 'project' },
    })
    expect(puts(w)).toEqual([])
    expect(await within(item()).findByRole('status')).toHaveTextContent(
      'Saved a copy as a new query.',
    )
    expect(w.calls('POST', '/queries')).toEqual([])
  })

  it('keeps the copy name within the name rules', async () => {
    const user = userEvent.setup()
    const w = world()
    listWith(w, [savedFixture({ id: ID, name: 'n'.repeat(120) })])
    mountSql(SQL, w)
    await editor()
    await openMenu(user, await itemFor())
    await user.click(screen.getByRole('menuitem', { name: 'Save as copy' }))
    const dialog = await screen.findByRole('dialog')
    const value = (within(dialog).getByLabelText('Name') as HTMLInputElement).value
    expect([...value]).toHaveLength(120)
    expect(value.endsWith(' (copy)')).toBe(true)
  })

  it('says why a change failed and keeps the dialog open for a rename', async () => {
    const user = userEvent.setup()
    const w = world()
    listWith(w, [savedFixture({ id: ID })])
    w.updateSaved = () => ({
      status: 409,
      body: { code: 'CONFLICT', message: 'The saved query has another revision.' },
    })
    mountSql(SQL, w)
    await editor()
    await openMenu(user, await itemFor())
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Name'), ' 2')
    await user.click(within(dialog).getByRole('button', { name: 'Rename saved query' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The saved query has another revision. (CONFLICT)',
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('says why a change of visibility failed and does not show it as done', async () => {
    const user = userEvent.setup()
    const w = world()
    listWith(w, [savedFixture({ id: ID })])
    w.updateSaved = () => ({
      status: 403,
      body: { code: 'FORBIDDEN', message: 'Only the owner changes a saved query.' },
    })
    mountSql(SQL, w)
    await editor()
    const row = await itemFor()
    await openMenu(user, row)
    await user.click(screen.getByRole('menuitemradio', { name: 'Shared in scope' }))
    const alert = await within(row).findByRole('alert')
    expect(alert).toHaveTextContent('Could not change the saved query')
    expect(alert).toHaveTextContent('Only the owner changes a saved query. (FORBIDDEN)')
    expect(within(row).queryByRole('status')).toBeNull()
  })

  it('changes nothing when the stored version cannot be read', async () => {
    const user = userEvent.setup()
    const w = world()
    listWith(w, [savedFixture({ id: ID })])
    w.getSaved = () => ({ status: 500, body: { code: 'INTERNAL', message: 'Store down.' } })
    mountSql(SQL, w)
    await editor()
    const row = await itemFor()
    await openMenu(user, row)
    await user.click(screen.getByRole('menuitemradio', { name: 'Shared in scope' }))
    expect(await within(row).findByRole('alert')).toHaveTextContent('Store down. (INTERNAL)')
    expect(puts(w)).toEqual([])
  })

  it('opens from the keyboard and closes with Escape, and passes axe with the menu and the dialog open', async () => {
    const user = userEvent.setup()
    const w = world()
    listWith(w, [savedFixture({ id: ID })])
    mountSql(SQL, w)
    await editor()
    const trigger = within(await itemFor()).getByRole('button', { name: 'Actions' })
    trigger.focus()
    await user.keyboard('{Enter}')
    const menu = await screen.findByRole('menu')
    expect(await axeViolations()).toEqual([])
    // Opened from the keyboard, the menu puts focus on its first item.
    await user.keyboard('{Enter}')
    const dialog = await screen.findByRole('dialog', { name: 'Rename the saved query' })
    expect(menu).not.toBeInTheDocument()
    expect(await axeViolations()).toEqual([])
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(dialog).not.toBeInTheDocument()
  })
})

describe('the actions on the tab of a saved query', () => {
  async function openInTab(user: ReturnType<typeof userEvent.setup>): Promise<HTMLTextAreaElement> {
    await user.click(within(await itemFor()).getByRole('button', { name: 'Open in a new tab' }))
    return await editor()
  }

  it('are in the tab strip for the selected tab of a query the person owns', async () => {
    const user = userEvent.setup()
    const w = world()
    listWith(w, [savedFixture({ id: ID })])
    mountSql(SQL, w)
    await editor()
    expect(screen.queryByRole('button', { name: /^Actions for the saved query/ })).toBeNull()
    await openInTab(user)
    expect(
      screen.getByRole('button', { name: 'Actions for the saved query in tab 2' }),
    ).toBeInTheDocument()
    expect(await axeViolations()).toEqual([])
  })

  it('are not offered for a query somebody else saved', async () => {
    const user = userEvent.setup()
    const w = world()
    listWith(w, [savedFixture({ id: ID, ownedByCaller: false })])
    mountSql(SQL, w)
    await editor()
    await openInTab(user)
    expect(screen.queryByRole('button', { name: /^Actions for the saved query/ })).toBeNull()
  })

  it('rename the stored query without saving the text of the tab, and say so', async () => {
    const user = userEvent.setup()
    const w = world()
    listWith(w, [savedFixture({ id: ID, revision: 3 })])
    mountSql(SQL, w)
    await editor()
    const area = await openInTab(user)
    type(area, 'SELECT 42')
    await user.click(screen.getByRole('button', { name: 'Actions for the saved query in tab 2' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }))
    const dialog = await screen.findByRole('dialog')
    await user.clear(within(dialog).getByLabelText('Name'))
    await user.type(within(dialog).getByLabelText('Name'), 'From the tab')
    await user.click(within(dialog).getByRole('button', { name: 'Rename saved query' }))
    await waitFor(() => expect(puts(w)).toHaveLength(1))
    expect(puts(w)[0]?.body).toEqual({
      name: 'From the tab',
      sql: STORED_SQL,
      visibility: 'personal',
      revision: 3,
    })
    expect(
      await screen.findByText('Renamed. The saved query is at revision 4.'),
    ).toBeInTheDocument()
    expect(area).toHaveValue('SELECT 42')
  })

  it('change who sees the query and say who sees it now', async () => {
    const user = userEvent.setup()
    const w = world()
    listWith(w, [savedFixture({ id: ID, revision: 1 })])
    mountSql(SQL, w)
    await editor()
    await openInTab(user)
    await user.click(screen.getByRole('button', { name: 'Actions for the saved query in tab 2' }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'Shared in scope' }))
    await waitFor(() => expect(puts(w)).toHaveLength(1))
    expect(puts(w)[0]?.body).toMatchObject({ visibility: 'project', revision: 1, sql: STORED_SQL })
    expect(await screen.findByText(/can see this saved query now. Revision 2./)).toBeInTheDocument()
  })

  it('say why a change failed in the note of the tab', async () => {
    const user = userEvent.setup()
    const w = world()
    listWith(w, [savedFixture({ id: ID })])
    w.updateSaved = () => ({
      status: 409,
      body: { code: 'CONFLICT', message: 'The saved query has another revision.' },
    })
    mountSql(SQL, w)
    await editor()
    await openInTab(user)
    await user.click(screen.getByRole('button', { name: 'Actions for the saved query in tab 2' }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'Shared in scope' }))
    expect(await screen.findByText('Could not save the query')).toBeInTheDocument()
    expect(screen.getByText('The saved query has another revision. (CONFLICT)')).toBeInTheDocument()
  })

  it('save the current text as a copy and let the tab follow the copy', async () => {
    const user = userEvent.setup()
    const w = world()
    listWith(w, [savedFixture({ id: ID, name: 'Open orders' })])
    w.createSaved = (body) => ({
      status: 201,
      body: savedFixture({
        id: OTHER,
        name: String(body['name']),
        sql: String(body['sql']),
        scope: { kind: 'target', targetId: 'tgt_00000000000000000000000002' },
      }),
    })
    mountSql(SQL, w)
    await editor()
    const area = await openInTab(user)
    type(area, 'SELECT id FROM public.orders WHERE edited')
    await user.click(screen.getByRole('button', { name: 'Actions for the saved query in tab 2' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Save as copy' }))
    const dialog = await screen.findByRole('dialog', { name: 'Save a copy of the query' })
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Open orders (copy)')
    await user.click(within(dialog).getByRole('button', { name: 'Save copy' }))
    await waitFor(() => expect(w.calls('POST', '/saved-queries')).toHaveLength(1))
    expect(w.calls('POST', '/saved-queries')[0]?.body).toMatchObject({
      name: 'Open orders (copy)',
      sql: 'SELECT id FROM public.orders WHERE edited',
      scope: { kind: 'target', target: STAGING },
    })
    expect(puts(w)).toEqual([])
    // The tab now holds the copy: Save updates the copy, not the original.
    fireEvent.keyDown(document.body, { key: 's', ctrlKey: true })
    await waitFor(() => expect(puts(w)).toHaveLength(1))
    expect(w.calls('PUT', `/saved-queries/${OTHER}`)).toHaveLength(1)
    expect(w.calls('PUT', `/saved-queries/${ID}`)).toEqual([])
  })
})
