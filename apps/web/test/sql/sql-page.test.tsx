import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  BIDI,
  classifyText,
  historyEntry,
  mountSql,
  project,
  resultFixture,
  SqlWorld,
  savedFixture,
  TAG,
  ZWSP,
} from './support.tsx'

// The target pages run in the shortcut and command providers of the real shell, without the rail.
vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

// The editor and the grid are lazy chunks (tested in packages/ui-data); stand-ins that record what
// the page gives them (see stand-ins.tsx).
vi.mock('@exponetdb/ui-data/editor/sql-editor', async () =>
  (await import('./stand-ins.tsx')).editorModule(),
)
vi.mock('@exponetdb/ui-data/grid/data-grid', async () =>
  (await import('./stand-ins.tsx')).gridModule(),
)

const STAGING = 'shop/platform/staging'
const SQL = '/t/shop/platform/staging/sql'
const PROD_SQL = '/t/shop/platform/production/sql'

beforeEach(() => {
  try {
    window.localStorage.clear()
  } catch {
    // no storage in this run
  }
})

afterEach(() => {
  cleanup()
})

// The first mount of the workspace in a file is slow: the lazy chunks load and the whole tree
// renders for the first time. On CI's two cores, shared by every package's tests, that ran past
// the 10 s wait of the file's first test. One throwaway mount here takes that cost outside of
// any test; every test still mounts its own app.
beforeAll(async () => {
  mountSql(SQL, world())
  await screen.findByRole('textbox', { name: /SQL (query|draft)/ }, { timeout: 100_000 })
  cleanup()
  window.localStorage.clear()
}, 120_000)

function world(): SqlWorld {
  const w = new SqlWorld()
  project(w)
  w.sample(STAGING)
  w.sample('shop/platform/production')
  return w
}

async function editor(): Promise<HTMLTextAreaElement> {
  return (await screen.findByRole('textbox', { name: /SQL (query|draft)/ })) as HTMLTextAreaElement
}

function type(area: HTMLTextAreaElement, text: string): void {
  fireEvent.change(area, { target: { value: text } })
}

async function classified(w: SqlWorld, count = 1): Promise<void> {
  await waitFor(() =>
    expect(w.calls('POST', '/sql/classifications').length).toBeGreaterThanOrEqual(count),
  )
}

describe('the SQL workspace', () => {
  it('opens in Query mode with the editor, the result hint and no read', async () => {
    const w = world()
    mountSql(SQL, w)
    const area = await editor()
    expect(area).toHaveAttribute('data-mode', 'query')
    expect(screen.getByRole('button', { name: /^Run/ })).toBeInTheDocument()
    expect(screen.getByText(/Nothing runs until you press Run/)).toBeInTheDocument()
    expect(document.querySelector('[data-production-cue]')).toBeNull()
    expect(w.calls('POST', '/queries')).toEqual([])
    expect(await axeViolations()).toEqual([])
  })

  it('shows the production cue on a production target', async () => {
    const w = world()
    mountSql(PROD_SQL, w)
    await editor()
    const cue = document.querySelector('[data-production-cue]')
    expect(cue).not.toBeNull()
    expect(cue?.textContent).toMatch(/Production target/)
    expect(await axeViolations()).toEqual([])
  })

  it('runs a read with Mod+Enter and shows the rows, the duration and the masked columns', async () => {
    const w = world()
    w.run = (body) => ({
      status: 200,
      body: resultFixture({
        queryId: body.queryId,
        truncated: true,
        truncation: { cap: 1000, reason: 'rows' },
        rlsRelations: ['public.orders'],
      }),
    })
    mountSql(SQL, w)
    const area = await editor()
    type(area, 'SELECT id, email FROM public.users')
    fireEvent.keyDown(area, { key: 'Enter', ctrlKey: true })
    const grid = await screen.findByTestId('grid')
    expect(grid).toHaveTextContent('2 columns, 2 rows')
    expect(grid).toHaveAttribute('data-masked', '1')
    expect(screen.getByText('2 rows in 5 ms.')).toBeInTheDocument()
    expect(screen.getByText(/cut at the 1,000 row limit/)).toBeInTheDocument()
    expect(screen.getByText(/masked by the target setting/)).toBeInTheDocument()
    expect(screen.getByText(/Row-level security is enabled on 1 relations/)).toBeInTheDocument()
    const sent = w.calls('POST', '/queries')
    expect(sent).toHaveLength(1)
    const body = sent[0]?.body as { sql: string; queryId: string }
    expect(body.sql).toBe('SELECT id, email FROM public.users')
    expect(body.queryId).toMatch(/^qry_[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
  })

  it('shows the server refusal text and code, never an empty result', async () => {
    const w = world()
    w.run = () => ({
      status: 403,
      body: {
        code: 'DATA_READ_NOT_PERMITTED',
        message: 'Data reads on this target are limited to people.',
      },
    })
    mountSql(PROD_SQL, w)
    const area = await editor()
    type(area, 'SELECT 1')
    await userEvent.click(screen.getByRole('button', { name: /^Run/ }))
    expect(
      await screen.findByText(/Data reads on this target are limited to people/),
    ).toBeInTheDocument()
    expect(screen.getByText(/DATA_READ_NOT_PERMITTED/)).toBeInTheDocument()
    expect(screen.queryByTestId('grid')).toBeNull()
    const result = document.querySelector('[data-block="sql-result"]') as HTMLElement
    expect(result).toHaveAttribute('data-state', 'failed')
    expect(within(result).queryByText(/Nothing to show/)).toBeNull()
  })

  it('offers a draft when the server refuses a text as not read-only', async () => {
    const w = world()
    w.classify = () => ({
      status: 500,
      body: { code: 'INTERNAL', message: 'Classification is down.' },
    })
    w.run = () => ({
      status: 422,
      body: { code: 'QUERY_NOT_READ_ONLY', message: 'Only one read-only statement is allowed.' },
    })
    mountSql(SQL, w)
    const area = await editor()
    type(area, 'UPDATE public.orders SET x = 1')
    await userEvent.click(screen.getByRole('button', { name: /^Run/ }))
    expect(await screen.findByText(/QUERY_NOT_READ_ONLY/)).toBeInTheDocument()
    expect(document.querySelector('[data-write-explanation="refused"]')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Draft as migration' })).toBeInTheDocument()
  })

  it('does not send a write as a query: it explains and offers a draft that keeps the text', async () => {
    const w = world()
    mountSql(SQL, w)
    const area = await editor()
    type(area, 'DROP TABLE public.orders')
    await userEvent.click(screen.getByRole('button', { name: /^Run/ }))
    await waitFor(() =>
      expect(document.querySelector('[data-write-explanation="held"]')).not.toBeNull(),
    )
    expect(screen.getAllByText(/Query mode does not send it/).length).toBeGreaterThan(0)
    expect(w.calls('POST', '/queries')).toEqual([])
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Draft as migration' })[0] as HTMLElement,
    )
    const draft = await screen.findByRole('textbox', { name: 'SQL draft of a change' })
    expect(draft).toHaveValue('DROP TABLE public.orders')
    expect(draft).toHaveAttribute('data-mode', 'draft')
    expect(screen.queryByRole('button', { name: /^Run/ })).toBeNull()
    expect(w.calls('POST', '/queries')).toEqual([])
  })

  it('shows a failed classification as a failure, never as safe', async () => {
    const w = world()
    w.classify = () => ({
      status: 503,
      body: { code: 'UNAVAILABLE', message: 'The parser is busy.' },
    })
    mountSql(`${SQL}?mode=draft`, w)
    const area = await editor()
    type(area, 'CREATE INDEX ON public.orders (id)')
    const block = await waitFor(() => {
      const found = document.querySelector('[data-block="sql-classification"][data-state="failed"]')
      if (found === null) throw new Error('not failed yet')
      return found as HTMLElement
    })
    expect(block).toHaveTextContent(/Could not read classification/)
    expect(block).toHaveTextContent(/This does not mean the text is safe/)
    expect(block).not.toHaveTextContent(/admits/)
    expect(area).toHaveAttribute('data-diagnostics', '[]')
  })

  it('says that a statement without a class is not safe and marks it as a warning', async () => {
    const w = world()
    w.classify = (sql) => {
      const base = classifyText(sql)
      return {
        status: 200,
        body: {
          ...base,
          readOnlyPath: {
            admitted: false,
            refusal: { code: 'QUERY_CONSTRUCT_UNSUPPORTED', reason: 'function' },
          },
          statements: base.statements.map((s) => ({
            ...s,
            classes: [],
            readOnlyPath: false,
            readOnlyRefusal: { code: 'QUERY_CONSTRUCT_UNSUPPORTED', reason: 'function' },
          })),
        },
      }
    }
    mountSql(`${SQL}?mode=draft`, w)
    const area = await editor()
    type(area, 'SELECT public.f()')
    expect(await screen.findByText(/No class: what it does cannot be derived/)).toBeInTheDocument()
    await waitFor(() => {
      const diagnostics = JSON.parse(area.getAttribute('data-diagnostics') ?? '[]') as {
        severity: string
        message: string
      }[]
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.severity).toBe('warning')
      expect(diagnostics[0]?.message).toMatch(/not safe by default/)
    })
    expect(screen.queryByText(/admits this statement/)).toBeNull()
  })

  it('cancels a running query by its id and says what the server answered', async () => {
    const w = world()
    let release: (value: unknown) => void = () => {}
    w.holds.set(
      'POST /api/v1/targets/shop%2Fplatform%2Fstaging/queries',
      new Promise((resolve) => {
        release = resolve
      }),
    )
    w.run = () => ({
      status: 409,
      body: { code: 'QUERY_CANCELED', message: 'The query was canceled.' },
    })
    mountSql(SQL, w)
    const area = await editor()
    type(area, 'SELECT pg_catalog.now()')
    await userEvent.click(screen.getByRole('button', { name: /^Run/ }))
    await waitFor(() => expect(w.calls('POST', '/queries').length).toBe(1))
    const result = await waitFor(() => {
      const found = document.querySelector('[data-block="sql-result"][data-state="running"]')
      if (found === null) throw new Error('not running')
      return found as HTMLElement
    })
    await userEvent.click(within(result).getByRole('button', { name: 'Cancel the query' }))
    const queryId = (w.calls('POST', '/queries')[0]?.body as { queryId: string } | undefined)
      ?.queryId
    await waitFor(() => expect(w.calls('POST', `/queries/${queryId}/cancel`)).toHaveLength(1))
    expect(await screen.findByText('The server canceled the query.')).toBeInTheDocument()
    await act(async () => release(undefined))
    expect(await screen.findByText(/QUERY_CANCELED/)).toBeInTheDocument()
    expect(screen.getByText('The server canceled the query.')).toBeInTheDocument()
  })

  it('shows EXPLAIN through the explain endpoint with its summary', async () => {
    const w = world()
    mountSql(SQL, w)
    const area = await editor()
    type(area, 'SELECT * FROM public.orders')
    await userEvent.click(screen.getByRole('button', { name: 'Explain' }))
    expect(await screen.findByText('Total cost')).toBeInTheDocument()
    expect(w.calls('POST', '/explain')).toHaveLength(1)
    expect(w.calls('POST', '/queries')).toEqual([])
  })
})

describe('the read states around the editor', () => {
  it('shows the saved list loading while its read runs', async () => {
    const w = world()
    w.holds.set('GET /api/v1/saved-queries', new Promise(() => {}))
    mountSql(SQL, w)
    await editor()
    expect(await screen.findByText(/Loading saved queries/)).toBeInTheDocument()
    expect(screen.queryByText(/found no saved queries/)).toBeNull()
  })

  it('does not classify a text over 64 KiB and says nothing is known about it', async () => {
    const w = world()
    mountSql(`${SQL}?mode=draft`, w)
    const area = await editor()
    type(area, `SELECT '${'x'.repeat(70_000)}'`)
    expect(
      await screen.findByText(/Not classified: the text is longer than 64 KiB/),
    ).toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(w.calls('POST', '/sql/classifications')).toEqual([])
  })

  it('passes axe in Draft mode with a classification and a result in Query mode', async () => {
    const w = world()
    mountSql(`${SQL}?mode=draft`, w)
    const area = await editor()
    type(area, 'SELECT 1; DROP TABLE public.orders')
    await waitFor(() => expect(document.querySelector('[data-statement="2"]')).not.toBeNull())
    expect(await axeViolations()).toEqual([])
    await userEvent.click(screen.getByRole('button', { name: 'Query', pressed: false }))
    type(await editor(), 'SELECT 1')
    await userEvent.click(screen.getByRole('button', { name: /^Run/ }))
    await screen.findByTestId('grid')
    expect(await axeViolations()).toEqual([])
  })
})

describe('deep links', () => {
  it('opens ?sql= text in a new tab with a note and never runs it', async () => {
    const w = world()
    mountSql(`${SQL}?sql=${encodeURIComponent('SELECT 1')}`, w)
    const area = await editor()
    expect(area).toHaveValue('SELECT 1')
    expect(screen.getByText('Opened from a link, not run')).toBeInTheDocument()
    await classified(w)
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(w.calls('POST', '/queries')).toEqual([])
    expect(w.calls('POST', '/explain')).toEqual([])
    expect(await axeViolations()).toEqual([])
  })

  it('opens ?mode=draft in Draft mode without a Run button', async () => {
    const w = world()
    mountSql(`${SQL}?mode=draft`, w)
    const area = await editor()
    expect(area).toHaveAttribute('data-mode', 'draft')
    expect(screen.queryByRole('button', { name: /^Run/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Create migration' })).toBeDisabled()
  })

  it('makes hostile link text visible: hidden characters counted, a DROP far down listed', async () => {
    const w = world()
    const filler = Array.from({ length: 299 }, (_, i) => `-- line ${i + 1}`).join('\n')
    const hostile = `SELECT 1 /* ${BIDI}${TAG}${ZWSP} */;\n${filler}\nDROP TABLE public.orders`
    mountSql(`${SQL}?mode=draft&sql=${encodeURIComponent(hostile)}`, w)
    const area = await editor()
    expect(area).toHaveValue(hostile)
    const note = document.querySelector('[data-origin-note="link"]')
    expect(note?.textContent).toMatch(/301 lines/)
    expect(document.querySelector('[data-hidden-count]')?.getAttribute('data-hidden-count')).toBe(
      '4',
    )
    const second = await waitFor(() => {
      const found = document.querySelector('[data-statement="2"]')
      if (found === null) throw new Error('no statement 2')
      return found as HTMLElement
    })
    expect(second).toHaveTextContent('Statement 2, lines 301 to 301')
    expect(second.querySelector('[data-classification="destructive"]')).not.toBeNull()
    const first = document.querySelector('[data-statement="1"]') as HTMLElement
    expect(first.textContent).toMatch(/U\+202E/)
    expect(first.innerHTML).not.toContain('<script')
    expect(w.calls('POST', '/queries')).toEqual([])
  })

  it('does not open link text over the bound and says so', async () => {
    const w = world()
    mountSql(`${SQL}?sql=${'x'.repeat(16_385)}`, w)
    await editor()
    expect(screen.getByText('Link text not opened')).toBeInTheDocument()
    expect((await editor()).value).toBe('')
  })

  it('opens the text of a later link on the same page in a new tab, never run', async () => {
    const w = world()
    const { router } = mountSql(SQL, w)
    await editor()
    await act(async () => {
      await router.navigate({ href: `${SQL}?sql=${encodeURIComponent('SELECT 3')}` })
    })
    await waitFor(async () => expect(await editor()).toHaveValue('SELECT 3'))
    expect(screen.getByText('Opened from a link, not run')).toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(w.calls('POST', '/queries')).toEqual([])
  })

  it('reads the parameter as plain text (a number stays text)', async () => {
    const w = world()
    mountSql(`${SQL}?sql=1`, w)
    expect(await editor()).toHaveValue('1')
  })
})

describe('history', () => {
  it('lists the redacted statements and opens one in a new tab without running it', async () => {
    const w = world()
    w.history = {
      status: 200,
      body: { items: [historyEntry()], nextCursor: null, source: 'audit' },
    }
    mountSql(SQL, w)
    await editor()
    await userEvent.click(screen.getByRole('tab', { name: 'History' }))
    expect(await screen.findByText(/WHERE id = \$1/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Open in a new tab' }))
    expect(await editor()).toHaveValue('SELECT * FROM public.orders WHERE id = $1')
    expect(screen.getByText('Opened from your history, not run')).toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(w.calls('POST', '/queries')).toEqual([])
    expect(await axeViolations()).toEqual([])
  })

  it('shows a failed history read as a failure, not as an empty history', async () => {
    const w = world()
    w.history = { status: 500, body: { code: 'INTERNAL', message: 'Audit unavailable.' } }
    mountSql(SQL, w)
    await editor()
    await userEvent.click(screen.getByRole('tab', { name: 'History' }))
    expect(await screen.findByText(/Could not read query history/)).toBeInTheDocument()
    expect(screen.queryByText(/found no query history/)).toBeNull()
  })

  it('shows an empty history only after a successful read', async () => {
    const w = world()
    mountSql(SQL, w)
    await editor()
    await userEvent.click(screen.getByRole('tab', { name: 'History' }))
    expect(await screen.findByText(/found no query history/)).toBeInTheDocument()
  })
})

describe('a partial list in the side panel', () => {
  it('shows a partial saved list as partial: it offers the rest and never says there are none', async () => {
    const w = world()
    w.saved = {
      status: 200,
      body: { items: [savedFixture({ name: 'orders' })], nextCursor: 'c2' },
    }
    mountSql(SQL, w)
    expect(await screen.findByRole('button', { name: 'Show more' })).toBeInTheDocument()
    expect(screen.queryByText(/found no saved queries/)).toBeNull()
  })

  it('shows a partial history as partial: it offers the rest and never says there is none', async () => {
    const w = world()
    w.history = {
      status: 200,
      body: { items: [historyEntry()], nextCursor: 'c2', source: 'audit' },
    }
    mountSql(SQL, w)
    await editor()
    await userEvent.click(screen.getByRole('tab', { name: 'History' }))
    expect(await screen.findByRole('button', { name: 'Show more' })).toBeInTheDocument()
    expect(screen.queryByText(/found no query history/)).toBeNull()
  })
})

describe('saved queries', () => {
  it('lists saved queries with hostile names as text and opens one without running it', async () => {
    const w = world()
    const name = `<script>x</script> ${BIDI}orders`
    w.saved = { status: 200, body: { items: [savedFixture({ name })], nextCursor: null } }
    mountSql(SQL, w)
    await editor()
    const block = await waitFor(() => {
      const found = document.querySelector('[data-saved]')
      if (found === null) throw new Error('no saved item')
      return found as HTMLElement
    })
    expect(block.textContent).toContain('<script>x</script>')
    expect(block.textContent).toMatch(/U\+202E/)
    expect(block.querySelector('script')).toBeNull()
    await userEvent.click(within(block).getByRole('button', { name: 'Open in a new tab' }))
    expect(await editor()).toHaveValue('SELECT id FROM public.orders')
    expect(screen.getByText('Opened from a saved query, not run')).toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(w.calls('POST', '/queries')).toEqual([])
  })

  it('shows a failed list as a failure', async () => {
    const w = world()
    w.saved = { status: 500, body: { code: 'INTERNAL', message: 'Store down.' } }
    mountSql(SQL, w)
    expect(await screen.findByText(/Could not read saved queries/)).toBeInTheDocument()
    expect(screen.queryByText(/found no saved queries/)).toBeNull()
  })

  it('saves a new query through the dialog and never runs it', async () => {
    const w = world()
    mountSql(SQL, w)
    const area = await editor()
    type(area, 'SELECT 2')
    await userEvent.click(screen.getByRole('button', { name: /^Save query/ }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Two')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save query' }))
    await waitFor(() => expect(w.calls('POST', '/saved-queries')).toHaveLength(1))
    expect(w.calls('POST', '/saved-queries')[0]?.body).toEqual({
      name: 'Two',
      sql: 'SELECT 2',
      visibility: 'personal',
      scope: { kind: 'target', target: STAGING },
    })
    expect(await screen.findByText('Saved as revision 1.')).toBeInTheDocument()
    expect(w.calls('POST', '/queries')).toEqual([])
  })

  it('saves changes with Mod+S at the revision read and says when it is stale (409)', async () => {
    const w = world()
    w.saved = { status: 200, body: { items: [savedFixture({ revision: 3 })], nextCursor: null } }
    w.updateSaved = () => ({
      status: 409,
      body: { code: 'CONFLICT', message: 'The saved query has another revision.' },
    })
    mountSql(SQL, w)
    await editor()
    const block = await waitFor(() => {
      const found = document.querySelector('[data-saved]')
      if (found === null) throw new Error('no saved item')
      return found as HTMLElement
    })
    await userEvent.click(within(block).getByRole('button', { name: 'Open in a new tab' }))
    const area = await editor()
    type(area, 'SELECT id FROM public.orders WHERE open')
    fireEvent.keyDown(document.body, { key: 's', ctrlKey: true })
    await waitFor(() => expect(w.calls('PUT', '/saved-queries/')).toHaveLength(1))
    expect(w.calls('PUT', '/saved-queries/')[0]?.body).toMatchObject({
      revision: 3,
      sql: 'SELECT id FROM public.orders WHERE open',
    })
    expect(await screen.findByText('The saved query changed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save as a new query' })).toBeInTheDocument()
    expect(w.calls('POST', '/queries')).toEqual([])
  })
})

describe('the migration draft', () => {
  it('lints a bundle draft with a failing verify skeleton and creates a plan, never applying', async () => {
    const w = world()
    const { router } = mountSql(`${SQL}?mode=draft`, w)
    const area = await editor()
    type(area, 'CREATE INDEX orders_user_idx ON public.orders (user_id)')
    await classified(w)
    await userEvent.click(screen.getByRole('button', { name: 'Create migration' }))
    const draft = await waitFor(() => {
      const found = document.querySelector('[data-block="sql-bundle-draft"]')
      if (found === null) throw new Error('no draft')
      return found as HTMLElement
    })
    await userEvent.type(within(draft).getByLabelText('Name'), 'add-orders-user-index')
    await userEvent.type(within(draft).getByLabelText('Description'), 'Index for lookups by user.')
    await userEvent.click(within(draft).getByRole('button', { name: 'Check the bundle' }))
    await waitFor(() => expect(w.calls('POST', '/migrations/lint')).toHaveLength(1))
    const body = w.calls('POST', '/migrations/lint')[0]?.body as {
      bundles: { directory: string; files: Record<string, string> }[]
    }
    const bundle = body.bundles[0]
    expect(bundle?.directory).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}_add-orders-user-index$/)
    expect(bundle?.files['up.sql']).toBe('CREATE INDEX orders_user_idx ON public.orders (user_id)')
    expect(bundle?.files['verify.sql']).toContain('SELECT false AS ok;')
    expect(bundle?.files['migration.yaml']).toContain('schema: exponetdb.migration/v1')
    expect(await screen.findByText('The lint found nothing.')).toBeInTheDocument()
    await userEvent.click(within(draft).getByRole('button', { name: 'Create plan' }))
    const confirm = await screen.findByRole('alertdialog')
    await userEvent.click(within(confirm).getByRole('button', { name: 'Create plan' }))
    await waitFor(() => expect(w.calls('POST', '/migrations/plans')).toHaveLength(1))
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/changes/plans/pln_01M4V3RV9F5XM2TB8KC6QZJ0NS'),
    )
    expect(w.sent.some((s) => /apply|verifications/.test(s.path) && s.method === 'POST')).toBe(
      false,
    )
  })
})

describe('shortcuts', () => {
  it('lists Run and Save in the shortcut sheet on the SQL page', async () => {
    const w = world()
    mountSql(SQL, w)
    await editor()
    ;(document.querySelector('#content') as HTMLElement).focus()
    fireEvent.keyDown(document.body, { key: '?', shiftKey: true })
    const sheet = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })
    expect(within(sheet).getByText('Run the query')).toBeInTheDocument()
    expect(within(sheet).getByText('Save the query')).toBeInTheDocument()
    expect(within(sheet).getByText('SQL editor')).toBeInTheDocument()
  })
})
