import '@testing-library/jest-dom/vitest'
import { act, cleanup, configure, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  AGO,
  BIDI,
  mountOps,
  NOW,
  OpsWorld,
  PROD_TARGET,
  project,
  stream,
  TAG_CHAR,
  TARGET,
  ulid,
  withDefaults,
  ZERO_WIDTH,
} from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

// The pages mount the whole route tree and the side panel loads lazily; a busy machine needs time.
configure({ asyncUtilTimeout: 5_000 })
vi.setConfig({ testTimeout: 30_000 })

afterEach(cleanup)

const PROJECT = 'prj_00000000000000000000000001'
const PENDING = ulid(9)
const PLANNED = `pln_${ulid(40)}`
const enc = (path: string) => encodeURIComponent(path)
const label = (cp: number) => `⟨U+${cp.toString(16).toUpperCase().padStart(4, '0')}⟩`

const UP_SQL = [
  'CREATE TABLE public.invoices (id bigint primary key);',
  `-- approved ${BIDI}evil${ZERO_WIDTH} </script><script>alert(1)</script><img src=x onerror=1>`,
  `ALTER TABLE public.invoices ADD COLUMN note${TAG_CHAR} text;`,
].join('\n')
const VERIFY_SQL = 'SELECT count(*) = 1 AS ok FROM pg_class;'
const DOWN_SQL = 'DROP TABLE public.invoices;'

const digest = (c: string) => `sha256:${c.repeat(64)}`

function revision(n: number, files: readonly string[] = ['up.sql', 'verify.sql', 'down.sql']) {
  return {
    revision: n,
    bundleDigest: `sha256:c1:${String(n).repeat(64)}`,
    verifyDigest: `sha256:c1:${'e'.repeat(64)}`,
    rollbackDigest: files.includes('down.sql') ? `sha256:c1:${'f'.repeat(64)}` : null,
    sourceDigest: digest('a'),
    files: Object.fromEntries(
      ['migration.yaml', ...files].map((file) => [file, { bytes: 10, digest: digest('b') }]),
    ),
    source: null,
    ingestedAt: AGO(3_600_000 * n),
  }
}

function bundle(over: Record<string, unknown> = {}) {
  return {
    projectId: PROJECT,
    migrationId: PENDING,
    name: 'add_invoices',
    checksum: `sha256:c1:${'c'.repeat(64)}`,
    transactional: true,
    dependsOn: [ulid(2)],
    revisions: [revision(1)],
    superseded: [],
    ...over,
  }
}

function detail(over: Record<string, unknown> = {}) {
  return {
    targetId: 'tgt_00000000000000000000000002',
    migrationId: PENDING,
    state: 'pending',
    checksum: null,
    appliedAt: null,
    operationId: null,
    planId: null,
    fingerprintBefore: null,
    fingerprintAfter: null,
    events: [],
    verifications: [],
    source: 'live',
    observedAt: NOW(),
    ...over,
  }
}

const BUNDLE = new RegExp(`/api/v1/projects/${PROJECT}/bundles/${PENDING}$`)
const fileRoute = (file: string, rev = 1) =>
  new RegExp(`/api/v1/projects/${PROJECT}/bundles/${PENDING}/revisions/${rev}/files/${file}$`)
const onTarget = (path: string) => new RegExp(`/api/v1/targets/${enc(path)}/migrations/${PENDING}$`)
const plans = (path: string) => new RegExp(`/api/v1/targets/${enc(path)}/migrations/plans$`)

function file(name: string, text: string, rev = 1) {
  return {
    migrationId: PENDING,
    revision: rev,
    file: name,
    text,
    bytes: text.length,
    digest: digest('b'),
  }
}

function world(path = TARGET): OpsWorld {
  const w = new OpsWorld()
  project(w)
  w.sample(path)
  withDefaults(w, path)
  w.on('GET', BUNDLE, bundle())
  w.on('GET', fileRoute('up.sql'), file('up.sql', UP_SQL))
  w.on('GET', fileRoute('verify.sql'), file('verify.sql', VERIFY_SQL))
  w.on('GET', fileRoute('down.sql'), file('down.sql', DOWN_SQL))
  w.on('GET', onTarget(path), detail())
  w.on('POST', plans(path), { id: PLANNED, kind: 'migration.apply' }, 201)
  return w
}

const page = (path = TARGET) => `/t/${path}/migrations`

async function section(name: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { level: 2, name })
  const root = heading.closest('[data-slot="page-section"]')
  if (!(root instanceof HTMLElement)) throw new Error(`no section ${name}`)
  return root
}

async function pendingBlock(): Promise<HTMLElement> {
  const ledger = await section('Ledger')
  await within(ledger).findByRole('table', {
    name: 'Bundles of the project not yet applied to this target',
  })
  const block = ledger.querySelector('[data-pending-block]')
  if (!(block instanceof HTMLElement)) throw new Error('no pending block')
  return block
}

async function openSheet(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  const block = await pendingBlock()
  await user.click(within(block).getByRole('button', { name: `View SQL of migration ${PENDING}` }))
  return screen.findByRole('dialog', { name: 'Migration SQL' })
}

describe('plan a pending bundle on this target', () => {
  it('plans the chosen bundles by id through the plan action and opens the plan page', async () => {
    const user = userEvent.setup()
    const w = world()
    const { router } = mountOps(page(), w)
    const block = await pendingBlock()
    const action = within(block).getByRole('button', { name: 'Plan on staging' })
    // Nothing chosen yet: the action says what to do and sends nothing.
    expect(action).toHaveAttribute('aria-disabled', 'true')
    expect(within(block).getByText('Select the bundles to plan.')).toBeInTheDocument()
    await user.click(within(block).getByRole('checkbox', { name: `Select migration ${PENDING}` }))
    expect(within(block).getByText('1 selected.')).toBeInTheDocument()
    await user.click(action)
    const dialog = await screen.findByRole('alertdialog', { name: 'Plan on staging?' })
    expect(within(dialog).getByText('add_invoices')).toBeInTheDocument()
    expect(w.callsTo('POST', plans(TARGET))).toHaveLength(0)
    await user.click(within(dialog).getByRole('button', { name: 'Create plan' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLANNED}`))
    const sent = w.callsTo('POST', plans(TARGET))
    expect(sent).toHaveLength(1)
    // By id only: the server takes the stored bundle and orders by dependsOn.
    expect(sent[0]?.body).toEqual({ migrationIds: [PENDING] })
  })

  it('asks for a fresh proof on REAUTH_REQUIRED and sends the same plan once more', async () => {
    const user = userEvent.setup()
    const w = world()
    let calls = 0
    w.on('POST', plans(TARGET), () => {
      calls += 1
      return calls === 1
        ? { status: 403, code: 'REAUTH_REQUIRED', message: 'Confirm it is you.' }
        : { status: 201, body: { id: PLANNED } }
    })
    w.on('POST', /\/auth\/reauth\/totp$/, { reauthenticatedAt: NOW() })
    const { router } = mountOps(page(), w)
    const block = await pendingBlock()
    await user.click(within(block).getByRole('checkbox', { name: `Select migration ${PENDING}` }))
    await user.click(within(block).getByRole('button', { name: 'Plan on staging' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Plan on staging?' })
    await user.click(within(dialog).getByRole('button', { name: 'Create plan' }))
    const reauth = await screen.findByRole('dialog', { name: 'Confirm it is you' })
    await user.type(
      within(reauth).getByLabelText('Or enter the code from your authenticator app'),
      '123456',
    )
    await user.click(within(reauth).getByRole('button', { name: 'Confirm with code' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLANNED}`))
    const sent = w.callsTo('POST', plans(TARGET))
    expect(sent).toHaveLength(2)
    expect(sent[1]?.body).toEqual(sent[0]?.body)
  })

  it('shows a refusal with the server catalog text and code, and stays on the page', async () => {
    const user = userEvent.setup()
    const w = world()
    w.fail('POST', plans(TARGET), 409, 'MIGRATION_DEPENDENCY_MISSING')
    const { router } = mountOps(page(), w)
    const block = await pendingBlock()
    await user.click(within(block).getByRole('checkbox', { name: 'Select all bundles' }))
    await user.click(within(block).getByRole('button', { name: 'Plan on staging' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Plan on staging?' })
    await user.click(within(dialog).getByRole('button', { name: 'Create plan' }))
    expect(
      await within(dialog).findByText('MIGRATION_DEPENDENCY_MISSING happened.'),
    ).toBeInTheDocument()
    expect(within(dialog).getByText('MIGRATION_DEPENDENCY_MISSING')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe(page())
  })

  it('on production, names the evidence state before sending and still offers the plan', async () => {
    const user = userEvent.setup()
    const w = world(PROD_TARGET)
    const s = stream()
    w.on('GET', /\/api\/v1\/projects\/[^/]+\/migrations$/, {
      ...s,
      bundles: [
        ...s.bundles,
        {
          migrationId: PENDING,
          name: 'add_invoices',
          revision: 1,
          checksum: `sha256:c1:${'c'.repeat(64)}`,
          dependsOn: [],
          states: [
            {
              environment: 'staging',
              state: 'applied',
              checksum: null,
              checksumMatches: true,
              appliedAt: AGO(60_000),
              verification: null,
              observedAt: AGO(60_000),
            },
          ],
        },
      ],
    })
    const { router } = mountOps(page(PROD_TARGET), w)
    const block = await pendingBlock()
    expect(
      await within(block).findByText(
        'Not verified on staging: production will refuse it unless break-glass applies.',
      ),
    ).toBeInTheDocument()
    // The server decides: the action is offered, with the production cue.
    expect(within(block).getByText('Production')).toBeInTheDocument()
    await user.click(within(block).getByRole('checkbox', { name: `Select migration ${PENDING}` }))
    await user.click(within(block).getByRole('button', { name: 'Plan on production' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Plan on production?' })
    expect(dialog.querySelector('[data-slot="confirm-frame"]')).toHaveAttribute('data-tier', 'prod')
    expect(dialog.querySelector('[data-evidence="not_verified"]')).not.toBeNull()
    expect(
      within(dialog).getByText(/1 of these bundles have no verified evidence/),
    ).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Create plan' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLANNED}`))
    expect(w.callsTo('POST', plans(PROD_TARGET))[0]?.body).toEqual({ migrationIds: [PENDING] })
  })

  it('says "Verified on staging" when the mirror holds a passed verification of the same checksum', async () => {
    const w = world(PROD_TARGET)
    const s = stream()
    w.on('GET', /\/api\/v1\/projects\/[^/]+\/migrations$/, {
      ...s,
      bundles: [
        {
          migrationId: PENDING,
          name: 'add_invoices',
          revision: 1,
          checksum: `sha256:c1:${'c'.repeat(64)}`,
          dependsOn: [],
          states: [
            {
              environment: 'staging',
              state: 'verified',
              checksum: `sha256:c1:${'c'.repeat(64)}`,
              checksumMatches: true,
              appliedAt: AGO(60_000),
              verification: { status: 'passed', verifiedAt: AGO(30_000) },
              observedAt: AGO(60_000),
            },
          ],
        },
      ],
    })
    mountOps(page(PROD_TARGET), w)
    const block = await pendingBlock()
    expect(await within(block).findByText('Verified on staging.')).toBeInTheDocument()
  })
})

describe('the SQL side panel', () => {
  it('shows each file as numbered text; hostile SQL stays text; down.sql never runs automatically', async () => {
    const user = userEvent.setup()
    mountOps(page(), world())
    const sheet = await openSheet(user)
    const up = await waitFor(() => {
      const element = sheet.querySelector('[data-bundle-file="up.sql"]')
      if (!(element instanceof HTMLElement)) throw new Error('no up.sql yet')
      return element
    })
    expect(up.querySelectorAll('tbody tr[data-line]')).toHaveLength(3)
    expect(up.textContent).toContain(label(0x202e))
    expect(up.textContent).toContain(label(0x200b))
    expect(up.textContent).toContain(label(0xe0041))
    expect(up.textContent).not.toContain(BIDI)
    expect(up.textContent).toContain('</script><script>alert(1)</script><img src=x onerror=1>')
    for (const tag of ['script', 'img', 'iframe']) {
      expect(sheet.querySelectorAll(tag), tag).toHaveLength(0)
    }
    expect(within(up).getByRole('note')).toHaveTextContent(
      /hidden characters? shown as code points/,
    )
    expect(await within(sheet).findByText(VERIFY_SQL)).toBeInTheDocument()
    expect(
      within(sheet).getByText(
        'Never runs automatically: down.sql runs only in a rollback plan that a person creates.',
      ),
    ).toBeInTheDocument()
    expect(await within(sheet).findByText(DOWN_SQL)).toBeInTheDocument()
    // The stored bundle with its checksum, dependency and revision digests.
    expect(within(sheet).getByRole('table', { name: 'Revisions of this bundle, newest first' }))
    expect(sheet.textContent).toContain(ulid(2))
  })

  it('a failed read of one file names its failure and leaves the other files as they are', async () => {
    const user = userEvent.setup()
    const w = world()
    w.fail('GET', fileRoute('verify.sql'), 500, 'INTERNAL')
    mountOps(page(), w)
    const sheet = await openSheet(user)
    expect(await within(sheet).findByText(/Could not read verify\.sql/)).toBeInTheDocument()
    expect(
      within(sheet).getByText(/This does not mean there is no verify\.sql/),
    ).toBeInTheDocument()
    expect(await within(sheet).findByText(DOWN_SQL)).toBeInTheDocument()
    expect(sheet.querySelector('[data-bundle-file="up.sql"]')).not.toBeNull()
  })

  it('a failed bundle read is failed, and the files say why they cannot be read', async () => {
    const user = userEvent.setup()
    const w = world()
    w.fail('GET', BUNDLE, 500, 'INTERNAL')
    mountOps(page(), w)
    const sheet = await openSheet(user)
    expect(await within(sheet).findByText(/Could not read stored bundle/)).toBeInTheDocument()
    expect(await within(sheet).findByText(/its revision is not known/)).toBeInTheDocument()
    expect(w.callsTo('GET', /\/files\//)).toHaveLength(0)
  })

  it('says no event and no verification run only after a successful read of the target', async () => {
    const user = userEvent.setup()
    mountOps(page(), world())
    const sheet = await openSheet(user)
    expect(
      await within(sheet).findByText(
        'The read succeeded: no event is recorded for this migration here.',
      ),
    ).toBeInTheDocument()
    expect(
      within(sheet).getByText(
        'The read succeeded: no verification run is recorded for this migration here.',
      ),
    ).toBeInTheDocument()
    expect(within(sheet).getByText('Pending (not applied)')).toBeInTheDocument()
  })

  it('shows the events and runs of an earlier read as stale with its age and a refresh', async () => {
    const user = userEvent.setup()
    const w = world()
    w.on(
      'GET',
      onTarget(TARGET),
      detail({
        state: 'applied',
        observedAt: AGO(3 * 3_600_000),
        operationId: `op_${ulid(3)}`,
        events: [
          {
            at: AGO(4_000_000),
            event: 'applied',
            operationId: `op_${ulid(3)}`,
            statementIndex: null,
            sqlstate: null,
          },
        ],
        verifications: [
          {
            verificationId: `vfy_${ulid(4)}`,
            migrationId: PENDING,
            operationId: `op_${ulid(3)}`,
            status: 'failed',
            startedAt: AGO(3_900_000),
            finishedAt: AGO(3_800_000),
            fingerprint: `fp1:17:${'a'.repeat(64)}`,
            verifyDigest: null,
            structural: { status: 'passed', checks: 3, failed: 0, firstFailure: null },
            runtime: {
              status: 'failed',
              checks: 1,
              failed: 1,
              firstFailure: { name: `check_${BIDI}x`, detail: '<b>bold</b>' },
            },
            engine: { status: 'skipped', checks: 0, failed: 0, firstFailure: null },
          },
        ],
      }),
    )
    mountOps(page(), w)
    const sheet = await openSheet(user)
    const target = await waitFor(() => {
      const element = sheet.querySelector('[data-on-target]')
      if (!(element instanceof HTMLElement) || element.querySelector('[data-event]') === null) {
        throw new Error('no target read yet')
      }
      return element
    })
    expect(within(target).getByRole('button', { name: /Refresh/ })).toBeInTheDocument()
    expect(within(target).getAllByRole('link', { name: 'View operation' })[0]).toHaveAttribute(
      'href',
      `/changes/operations/op_${ulid(3)}`,
    )
    expect(target.querySelector('[data-verification="failed"]')).not.toBeNull()
    expect(target.textContent).toContain(label(0x202e))
    expect(target.querySelector('b')).toBeNull()
  })

  it('compares two revisions; a file missing from one of them is a partial comparison', async () => {
    const user = userEvent.setup()
    const w = world()
    w.on('GET', BUNDLE, bundle({ revisions: [revision(1, ['up.sql', 'verify.sql']), revision(2)] }))
    w.on('GET', fileRoute('up.sql', 2), file('up.sql', `${UP_SQL}\n-- revised`, 2))
    w.on('GET', fileRoute('verify.sql', 2), file('verify.sql', VERIFY_SQL, 2))
    w.on('GET', fileRoute('down.sql', 2), file('down.sql', DOWN_SQL, 2))
    mountOps(page(), w)
    const sheet = await openSheet(user)
    const diff = await waitFor(() => {
      const element = sheet.querySelector('[data-revision-diff]')
      if (!(element instanceof HTMLElement)) throw new Error('no diff yet')
      return element
    })
    expect(within(diff).getByText('Revision 1 on the left, revision 2 on the right.'))
    await waitFor(() => expect(w.callsTo('GET', fileRoute('up.sql', 1))).toHaveLength(1))
    await user.selectOptions(within(diff).getByLabelText('File'), 'down.sql')
    expect(await within(diff).findByText(/down\.sql is not in revision 1/)).toBeInTheDocument()
    expect(diff.querySelector('[data-state="partial"]')).not.toBeNull()
    // Revision 1 has no down.sql: it is never requested.
    expect(w.callsTo('GET', fileRoute('down.sql', 1))).toHaveLength(0)
  })

  it('has no accessibility violations with the panel open', async () => {
    const user = userEvent.setup()
    mountOps(page(), world())
    const sheet = await openSheet(user)
    await within(sheet).findByText(DOWN_SQL)
    await act(async () => {})
    expect(await axeViolations(document.body)).toEqual([])
  })
})

describe('plan bundles on another environment from the migrations page', () => {
  it('offers the bundles the mirror holds as not applied on production and plans them there', async () => {
    const user = userEvent.setup()
    const w = world()
    w.on('POST', plans(PROD_TARGET), { id: PLANNED }, 201)
    const { router } = mountOps(page(), w)
    const promote = await section('Plan bundles on an environment')
    // From staging the panel opens on the environment that takes its evidence from staging.
    expect(await within(promote).findByLabelText('Environment')).toHaveValue('production')
    const table = within(promote).getByRole('table', { name: 'Bundles not applied on production' })
    expect(within(table).getByText('add_orders_1')).toBeInTheDocument()
    // add_orders_2 has no production record: offered, said to be not known, never "not applied".
    const unknown = table.querySelector(`[data-candidate="${ulid(2)}"]`) as HTMLElement
    expect(within(unknown).getByText('Not known (the mirror holds no record)')).toBeInTheDocument()
    expect(within(table).getAllByText(/Not verified on staging/)).toHaveLength(2)
    await user.click(within(table).getByRole('checkbox', { name: `Select migration ${ulid(1)}` }))
    await user.click(within(promote).getByRole('button', { name: 'Plan on production' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Plan on production?' })
    await user.click(within(dialog).getByRole('button', { name: 'Create plan' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLANNED}`))
    expect(w.callsTo('POST', plans(PROD_TARGET))[0]?.body).toEqual({ migrationIds: [ulid(1)] })
    expect(w.callsTo('POST', plans(TARGET))).toHaveLength(0)
  })

  it('links to the compare page of this target against its evidence environment', async () => {
    mountOps(page(), world())
    const timeline = await section('Across environments')
    expect(
      await within(timeline).findByRole('link', {
        name: 'Compare the schema with another environment',
      }),
    ).toHaveAttribute('href', `/t/${TARGET}/compare?to=development`)
    const promote = await section('Plan bundles on an environment')
    expect(
      await within(promote).findByRole('link', {
        name: 'Compare the schema of production with staging',
      }),
    ).toHaveAttribute('href', `/t/${PROD_TARGET}/compare?to=staging`)
  })

  it('shows a failed stream read as failed in the promotion section, never as nothing to plan', async () => {
    const w = world()
    w.fail('GET', /\/api\/v1\/projects\/[^/]+\/migrations$/, 500, 'INTERNAL_ERROR')
    mountOps(page(), w)
    const promote = await section('Plan bundles on an environment')
    expect(
      await within(promote).findByText(/Could not read migration timeline/),
    ).toBeInTheDocument()
    expect(within(promote).queryByText(/No bundle in this read is waiting/)).toBeNull()
  })
})
