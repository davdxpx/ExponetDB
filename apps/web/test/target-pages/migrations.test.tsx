import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  AGO,
  BIDI,
  HOSTILE,
  ledgerEntry,
  ledgerStatus,
  mountOps,
  must,
  nth,
  OpsWorld,
  plan,
  project,
  report,
  stream,
  TARGET,
  ulid,
  withDefaults,
} from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

afterEach(cleanup)

const PAGE = `/t/${TARGET}/migrations`
const LEDGER = /\/api\/v1\/targets\/shop%2Fplatform%2Fstaging\/migrations$/

function world(): OpsWorld {
  const w = new OpsWorld()
  project(w)
  w.sample(TARGET)
  return withDefaults(w)
}

async function section(name: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { level: 2, name })
  const root = heading.closest('[data-slot="page-section"]')
  if (!(root instanceof HTMLElement)) throw new Error(`no section ${name}`)
  return root
}

describe('the migrations page: ledger', () => {
  it('lists the applied migrations with checksum, time, operation link and verification', async () => {
    mountOps(PAGE, world())
    const ledger = await section('Ledger')
    const table = await within(ledger).findByRole('table', {
      name: 'Applied migrations of this target',
    })
    expect(within(table).getByText('add_orders_1')).toBeInTheDocument()
    expect(table.textContent).toContain(`sha256:c1:${'1'.padStart(64, 'a')}`.slice(0, 20))
    // Verified and pending are different words, not colors.
    expect(within(table).getByText(/^Verified/)).toBeInTheDocument()
    expect(within(table).getByText('Verification pending')).toBeInTheDocument()
    expect(within(table).getAllByRole('link', { name: 'View operation' })[0]).toHaveAttribute(
      'href',
      `/changes/operations/op_${ulid(1)}`,
    )
    // The pending bundles of the project are their own view.
    expect(within(ledger).queryByText('add_invoices')).toBeNull()
    cleanup()
    mountOps(`${PAGE}?view=pending`, world())
    const pending = await section('Pending bundles')
    expect(
      await within(pending).findByRole('table', {
        name: 'Bundles of the project not yet applied to this target',
      }),
    ).toBeInTheDocument()
    expect(within(pending).getByText('add_invoices')).toBeInTheDocument()
  })

  it('pages 120 pending bundles while "select all" still chooses every one', async () => {
    const user = userEvent.setup()
    const w = world()
    w.on(
      'GET',
      LEDGER,
      ledgerStatus({
        pending: Array.from({ length: 120 }, (_, i) => ({
          checksum: `sha256:c1:${'c'.repeat(64)}`,
          migrationId: ulid(100 + i),
          name: `bundle_${String(i).padStart(3, '0')}`,
        })),
      }),
    )
    mountOps(`${PAGE}?view=pending`, w)
    const pending = await section('Pending bundles')
    const table = await within(pending).findByRole('table', {
      name: 'Bundles of the project not yet applied to this target',
    })
    // A header row and one page of 50.
    expect(within(table).getAllByRole('row')).toHaveLength(51)
    const pager = within(pending).getByRole('navigation', { name: 'Pending bundle pages' })
    expect(pager).toHaveTextContent('1–50 of 120')
    await user.click(within(pager).getByRole('button', { name: 'Next' }))
    expect(within(table).getByText('bundle_050')).toBeInTheDocument()
  })

  it('says the empty ledger only after a successful read', async () => {
    const w = world()
    w.on('GET', LEDGER, ledgerStatus({ applied: [], pending: [] }))
    mountOps(PAGE, w)
    expect(
      await screen.findByText('The read succeeded: no migration is applied to this target yet.'),
    ).toBeInTheDocument()
    cleanup()
    mountOps(`${PAGE}?view=pending`, w)
    expect(
      await screen.findByText('The read succeeded: no bundle is pending for this target.'),
    ).toBeInTheDocument()
  })

  it('shows a failed read as failed, never as an empty ledger', async () => {
    const w = world()
    w.fail('GET', LEDGER, 500, 'INTERNAL_ERROR')
    mountOps(PAGE, w)
    const ledger = await section('Ledger')
    expect(await within(ledger).findByText(/Could not read ledger/)).toBeInTheDocument()
    expect(within(ledger).getByText(/This does not mean there is no ledger/)).toBeInTheDocument()
    expect(within(ledger).queryByText(/no migration is applied/)).toBeNull()
  })

  it('names the missing permission instead of an empty ledger', async () => {
    const w = world()
    w.fail('GET', LEDGER, 403, 'PERMISSION_DENIED')
    mountOps(PAGE, w)
    const ledger = await section('Ledger')
    expect(await within(ledger).findByText('migrations.read')).toBeInTheDocument()
    expect(within(ledger).queryByText(/no migration is applied/)).toBeNull()
  })

  it('shows an old read as stale with its age and a refresh', async () => {
    const w = world()
    w.on('GET', LEDGER, ledgerStatus({ observedAt: AGO(3 * 3_600_000) }))
    mountOps(PAGE, w)
    const ledger = await section('Ledger')
    expect(await within(ledger).findByRole('button', { name: /Refresh/ })).toBeInTheDocument()
    expect(within(ledger).getByText('add_orders_1')).toBeInTheDocument()
  })

  it('warns when the mirror differs from the ledger and when a non-transactional bundle is incomplete', async () => {
    const w = world()
    w.on(
      'GET',
      LEDGER,
      ledgerStatus({
        mirror: { inSync: false, checkedAt: AGO(1000) },
        incompleteNontransactional: [ulid(5)],
      }),
    )
    mountOps(PAGE, w)
    expect(
      await screen.findByText('The Control Store mirror differs from the ledger'),
    ).toBeInTheDocument()
    expect(screen.getByText('A non-transactional migration did not finish')).toBeInTheDocument()
  })

  it('renders hostile names as marked text, never as markup', async () => {
    const w = world()
    w.on(
      'GET',
      LEDGER,
      ledgerStatus({
        applied: [ledgerEntry(1, { name: HOSTILE, checksum: `sha256:c1:${BIDI}x` })],
      }),
    )
    mountOps(PAGE, w)
    const ledger = await section('Ledger')
    await within(ledger).findByRole('table', { name: 'Applied migrations of this target' })
    expect(ledger.querySelector('script')).toBeNull()
    expect(ledger.textContent).toContain('⟨U+202E⟩')
    expect(ledger.textContent).not.toContain(BIDI)
  })
})

describe('the migration centre: counters, views and history', () => {
  it('counts the ledger in cards that link to the history filtered by them', async () => {
    mountOps(PAGE, world())
    const counters = await screen.findByRole('list', { name: 'Ledger counters' })
    const verified = within(counters).getByRole('link', { name: /^Verified/ })
    expect(verified).toHaveAttribute(
      'href',
      `/t/${TARGET}/migrations?view=history&verification=passed`,
    )
    expect(within(counters).getByRole('link', { name: /^Not applied/ })).toHaveAttribute(
      'href',
      `/t/${TARGET}/migrations?view=pending`,
    )
    // One view at a time: the timeline, promotion and import are not in the document.
    expect(screen.queryByRole('heading', { level: 2, name: 'Across environments' })).toBeNull()
    expect(screen.queryByRole('heading', { level: 2, name: 'Legacy import' })).toBeNull()
    const views = screen.getByRole('navigation', { name: 'Migration views' })
    expect(within(views).getByRole('link', { name: 'History' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('renders one page of 500 imported entries, never the whole ledger, and pages through it', async () => {
    const user = userEvent.setup()
    const w = world()
    w.on(
      'GET',
      LEDGER,
      ledgerStatus({
        applied: Array.from({ length: 500 }, (_, i) =>
          ledgerEntry(i + 1, {
            origin: 'legacy_import',
            name: `legacy_${String(i).padStart(3, '0')}`,
          }),
        ),
      }),
    )
    const { router } = mountOps(PAGE, w)
    const table = await screen.findByRole('table', { name: 'Applied migrations of this target' })
    expect(within(table).getAllByRole('row')).toHaveLength(51)
    const pager = screen.getByRole('navigation', { name: 'History pages' })
    expect(pager).toHaveTextContent('1–50 of 500')
    expect(pager).toHaveTextContent('one live read of the ledger')
    await user.click(within(pager).getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(router.state.location.search).toMatchObject({ page: 2 }))
    expect(screen.getByRole('navigation', { name: 'History pages' })).toHaveTextContent(
      '51–100 of 500',
    )
    expect(
      screen
        .getByRole('list', { name: 'Ledger counters' })
        .querySelector('[data-counter="applied"]'),
    ).toHaveTextContent('500 imported from a legacy ledger')
    cleanup()
    // A link to a migration on another page says where it is and goes there.
    const deep = mountOps(`${PAGE}?migration=${ulid(120)}`, w)
    const notice = await screen.findByText('The migration in the address is on another page.')
    await user.click(
      within(notice.parentElement as HTMLElement).getByRole('button', { name: /^Go to page/ }),
    )
    await waitFor(() =>
      expect(deep.router.state.location.search).toMatchObject({ page: expect.any(Number) }),
    )
    expect(document.querySelector('[data-migration-elsewhere]')).toBeNull()
  })

  it('filters by text, origin and verification from the address, and says when none match', async () => {
    const user = userEvent.setup()
    mountOps(`${PAGE}?view=history&q=orders_1&origin=exponetdb`, world())
    const table = await screen.findByRole('table', { name: 'Applied migrations of this target' })
    expect(within(table).getByText('add_orders_1')).toBeInTheDocument()
    expect(within(table).queryByText('add_orders_2')).toBeNull()
    expect(screen.getByRole('searchbox', { name: 'Search the history' })).toHaveValue('orders_1')
    await user.selectOptions(screen.getByLabelText('Verification'), 'failed')
    expect(await screen.findByText('No entry of the ledger matches these filters.')).toBeVisible()
    // Said in a status line that stays when the pager is gone.
    expect(screen.getByText(/^0 of \d+ migrations match$/)).toHaveAttribute('role', 'status')
    await user.click(screen.getByRole('button', { name: 'Reset the filters' }))
    expect(
      await screen.findByRole('table', { name: 'Applied migrations of this target' }),
    ).toBeVisible()
  })

  it('drops search values outside the grammar of the address', async () => {
    const { router } = mountOps(
      `${PAGE}?view=nope&origin=evil&verification=x&page=-4&size=7&migration=../x&report=../y`,
      world(),
    )
    expect(
      await screen.findByRole('table', { name: 'Applied migrations of this target' }),
    ).toBeVisible()
    const search = router.state.matches.at(-1)?.search as Record<string, unknown>
    for (const key of ['view', 'origin', 'verification', 'page', 'size', 'migration', 'report']) {
      expect(search[key], key).toBeUndefined()
    }
  })
})

describe('the migrations page: timeline, plans and drift', () => {
  it('shows a cell with no record as unknown, never as not applied', async () => {
    mountOps(`${PAGE}?view=timeline`, world())
    const timeline = await section('Across environments')
    // Bundle 2 has no production cell: its production marker reads unknown.
    await within(timeline).findByText('add_orders_2')
    const unknown = within(timeline).getAllByText(/no record|unknown/i)
    expect(unknown.length).toBeGreaterThan(0)
    expect(timeline.textContent).toMatch(/shop|production/i)
  })

  it('names the environments the timeline cannot speak for', async () => {
    const w = world()
    const s = stream()
    const environments = s.environments.map((e) =>
      e.slug === 'production' ? { ...e, target: null } : e,
    )
    environments[0] = {
      ...nth(environments, 0),
      mirror: {
        ...must(nth(environments, 0).mirror),
        divergent: true,
        divergence: { missing: [ulid(1)], checksumDiffers: [], unrecorded: [] },
      },
    }
    w.on('GET', /\/api\/v1\/projects\/[^/]+\/migrations$/, { ...s, environments })
    mountOps(`${PAGE}?view=timeline`, w)
    const timeline = await section('Across environments')
    expect(await within(timeline).findByText(/No target you may see/)).toBeInTheDocument()
    expect(within(timeline).getByText(/1 missing, 0 with another checksum/)).toBeInTheDocument()
  })

  it('says a truncated stream is partial', async () => {
    const w = world()
    w.on(
      'GET',
      /\/api\/v1\/projects\/[^/]+\/migrations$/,
      stream({ truncated: true, bundleCount: 1500 }),
    )
    mountOps(`${PAGE}?view=timeline`, w)
    const timeline = await section('Across environments')
    expect(await within(timeline).findByText(/Showing part of/)).toBeInTheDocument()
  })

  it('shows a failed stream as failed', async () => {
    const w = world()
    w.fail('GET', /\/api\/v1\/projects\/[^/]+\/migrations$/, 500, 'INTERNAL_ERROR')
    mountOps(`${PAGE}?view=timeline`, w)
    const timeline = await section('Across environments')
    expect(
      await within(timeline).findByText(/Could not read migration timeline/),
    ).toBeInTheDocument()
  })

  it('lists the plans for this target with a link to each review page and says when more exist', async () => {
    const w = world()
    w.on('GET', /\/api\/v1\/plans\?/, { items: [plan(1), plan(2)], nextCursor: 'more' })
    mountOps(`${PAGE}?view=plans`, w)
    const plans = await section('Plans for this target')
    const table = await within(plans).findByRole('table', { name: 'Newest plans for this target' })
    expect(within(table).getByRole('link', { name: `pln_${ulid(1)}` })).toHaveAttribute(
      'href',
      `/changes/plans/pln_${ulid(1)}`,
    )
    expect(within(plans).getByText(/Showing part of/)).toBeInTheDocument()
    expect(within(plans).getByRole('link', { name: 'Open all plans' })).toHaveAttribute(
      'href',
      '/changes/plans',
    )
  })

  it('summarizes open drift findings and links to the drift page', async () => {
    const w = world()
    w.on('GET', /\/targets\/shop%2Fplatform%2Fstaging\/findings/, {
      items: [
        {
          id: `fnd_${ulid(1)}`,
          code: 'schema_drift',
          kind: 'drift',
          severity: 'critical',
          state: 'open',
          object: 'public.orders',
          summary: 's',
          firstSeenAt: AGO(1000),
          lastSeenAt: AGO(1000),
          occurrences: 1,
          resolution: null,
          resolvedAt: null,
          securityRelevant: false,
          subject: { clusterId: null, nodeId: null, targetId: null },
        },
      ],
      nextCursor: null,
    })
    mountOps(`${PAGE}?view=drift`, w)
    const drift = await section('Drift findings')
    expect(await within(drift).findByText('public.orders')).toBeInTheDocument()
    expect(
      within(drift).getByRole('link', { name: /Compare expected and actual/ }),
    ).toHaveAttribute('href', `/t/${TARGET}/drift`)
  })

  it('shows the production chip on a production target', async () => {
    const w = new OpsWorld()
    project(w)
    w.sample('shop/platform/production')
    withDefaults(w, 'shop/platform/production')
    mountOps('/t/shop/platform/production/migrations', w)
    expect(await screen.findByRole('heading', { level: 1, name: /Migrations/ })).toBeInTheDocument()
    await waitFor(() =>
      expect(document.querySelector('[data-slot="target-layout"]')).toHaveAttribute(
        'data-tier',
        'production',
      ),
    )
    expect(screen.getAllByText('Production').length).toBeGreaterThan(0)
  })

  it('has no accessibility violations', async () => {
    mountOps(PAGE, world())
    await section('Ledger')
    await screen.findByRole('table', { name: 'Applied migrations of this target' })
    await screen.findAllByText('add_orders_2')
    expect(await axeViolations(document.body)).toEqual([])
  })
})

describe('the legacy import review', () => {
  const REPORT_PAGE = `${PAGE}?report=imr_${ulid(1)}`
  const REPORT = new RegExp(`/import-reports/imr_${ulid(1)}$`)

  it('asks for a report id and refuses anything that is not one', async () => {
    const w = world()
    mountOps(`${PAGE}?view=import`, w)
    const user = userEvent.setup()
    const import_ = await section('Legacy import')
    await user.type(within(import_).getByLabelText('Import report id'), '../x')
    await user.click(within(import_).getByRole('button', { name: 'Open report' }))
    expect(await within(import_).findByRole('alert')).toHaveTextContent('not an import report id')
    expect(w.callsTo('GET', /import-reports/)).toHaveLength(0)
  })

  it('ignores a malformed report in the address and asks for nothing', async () => {
    const w = world()
    mountOps(`${PAGE}?view=import&report=../../x`, w)
    const import_ = await section('Legacy import')
    expect(await within(import_).findByLabelText('Import report id')).toBeInTheDocument()
    expect(w.callsTo('GET', /import-reports/)).toHaveLength(0)
  })

  it('shows the report: classification, evidence, undecided items; hostile names stay text', async () => {
    const w = world()
    w.on('GET', REPORT, report())
    mountOps(REPORT_PAGE, w)
    const import_ = await section('Legacy import')
    const table = await within(import_).findByRole('table', {
      name: 'Files of the legacy import and their classification',
    })
    expect(within(table).getByText('Recorded and present')).toBeInTheDocument()
    expect(within(table).getByText('Recorded, effect missing')).toBeInTheDocument()
    expect(within(table).getByText('Waiting for a decision')).toBeInTheDocument()
    expect(import_.querySelector('script')).toBeNull()
    expect(import_.textContent).toContain('⟨U+202E⟩')
    expect(import_.textContent).not.toContain(BIDI)
  })

  it('shows the strength of the ledger evidence and says when the report does not hold all of its drift', async () => {
    const w = world()
    const items = report().items
    w.on(
      'GET',
      REPORT,
      report({
        driftTotal: 812,
        driftTruncated: true,
        items: [
          { ...items[0], evidenceStrength: 'medium' },
          { ...items[1], evidenceStrength: 'weak' },
          {
            itemId: '3',
            legacyId: 'drift:table:public.acme_hand',
            name: 'table:public.acme_hand',
            state: 'ambiguous',
            contentDigest: null,
            evidence: ['only_in_target'],
            evidenceStrength: null,
            decision: null,
          },
        ],
      }),
    )
    mountOps(REPORT_PAGE, w)
    const import_ = await section('Legacy import')
    const table = await within(import_).findByRole('table', {
      name: 'Files of the legacy import and their classification',
    })
    expect(
      within(table).getByText('Medium (the same statements, comments ignored)'),
    ).toBeInTheDocument()
    expect(within(table).getByText('Weak (the name only; not recorded)')).toBeInTheDocument()
    expect(
      within(import_).getByText('This report does not hold all of its drift'),
    ).toBeInTheDocument()
    expect(import_.textContent).toContain('It holds 1 of 812 drift entries')
  })

  it('records a decision with a note and shows the updated report', async () => {
    const w = world()
    let current = report()
    w.on('GET', REPORT, () => ({ status: 200, body: current }))
    w.on('POST', /items\/2\/decision$/, (request) => {
      const body = request.body as { state: string; note: string }
      current = report({
        unresolved: 0,
        state: 'resolved',
        items: report().items.map((item) =>
          item.itemId === '2'
            ? {
                ...item,
                decision: {
                  state: body.state,
                  note: body.note,
                  decidedAt: new Date().toISOString(),
                },
              }
            : item,
        ),
      })
      return { status: 200, body: current }
    })
    mountOps(REPORT_PAGE, w)
    const user = userEvent.setup()
    const import_ = await section('Legacy import')
    await within(import_).findByRole('table', {
      name: 'Files of the legacy import and their classification',
    })
    // Only the review item can be decided.
    expect(import_.querySelectorAll('[data-decide]')).toHaveLength(1)
    await user.click(within(import_).getByRole('button', { name: /^Needs a decision/ }))
    await user.click(import_.querySelector('[data-decide="2"]') as HTMLElement)
    const dialog = await screen.findByRole('alertdialog')
    // Without a choice and a note nothing is sent.
    await user.click(within(dialog).getByRole('button', { name: 'Record decision' }))
    expect(await within(dialog).findByText('Choose a decision first.')).toBeInTheDocument()
    expect(w.callsTo('POST', /decision/)).toHaveLength(0)
    await user.selectOptions(within(dialog).getByLabelText('Decision'), 'unrecorded_missing')
    await user.type(within(dialog).getByLabelText('Note'), 'Never applied on this target')
    await user.click(within(dialog).getByRole('button', { name: 'Record decision' }))
    await waitFor(() => expect(w.callsTo('POST', /decision/)).toHaveLength(1))
    expect(w.callsTo('POST', /decision/)[0]?.body).toEqual({
      state: 'unrecorded_missing',
      note: 'Never applied on this target',
    })
    // The resolved report offers the baseline plan.
    expect(
      await within(import_).findByRole('button', { name: 'Create baseline plan' }),
    ).toBeInTheDocument()
    // The decided row stays under "Needs a decision" until the filter is chosen again.
    expect(import_.querySelector('[data-item="2"]')).not.toBeNull()
  })

  it('creates the baseline plan from a resolved report and opens the plan', async () => {
    const w = world()
    w.on('GET', REPORT, report({ state: 'resolved', unresolved: 0 }))
    w.on('POST', /baseline-plans$/, { id: `pln_${ulid(4)}` }, 201)
    const { router } = mountOps(REPORT_PAGE, w)
    const user = userEvent.setup()
    const import_ = await section('Legacy import')
    await user.click(await within(import_).findByRole('button', { name: 'Create baseline plan' }))
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Create plan' }))
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/changes/plans/pln_${ulid(4)}`),
    )
    expect(w.callsTo('POST', /baseline-plans$/)[0]?.body).toEqual({
      importReportId: `imr_${ulid(1)}`,
    })
  })

  it('shows a failed report read as failed', async () => {
    const w = world()
    w.fail('GET', REPORT, 500, 'INTERNAL_ERROR')
    mountOps(REPORT_PAGE, w)
    const import_ = await section('Legacy import')
    expect(await within(import_).findByText(/Could not read import report/)).toBeInTheDocument()
  })
})
