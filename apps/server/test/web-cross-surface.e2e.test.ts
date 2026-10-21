import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Scope } from '@exponetdb/contracts'
import { newUlid } from '@exponetdb/kernel'
import { databaseBootstrapStatements } from '@exponetdb/postgres'
import { createDatabase, runAsSuperuser, serverFor } from '@exponetdb/testkit'
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Locator,
  type Page,
} from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadWebAssets } from '../src/composition/access.ts'
import {
  bundle,
  DEFAULTS,
  McpCaller,
  type McpWorld,
  mcpWorld,
  OWNER_ROLE,
} from './support/mcp-int-world.ts'
import { ORIGIN, RP_ID } from './support/node-world.ts'

/**
 * One change across the three surfaces in a real browser (Wave 8 order §10,
 * Phase 15): a person registers two targets in the Web App (the register page
 * creates a plan, the plan review page applies it), an agent plans a migration
 * over MCP and proves it on the nonprod target, the production plan waits for a
 * person, who reviews and approves it in the Web App with a passkey; the worker
 * applies and verifies; the operation page shows "applied" and "verified" as
 * two separate indicators, and `/audit` and the target's Activity page list the
 * plan approval and the apply. The client's own name is text marked "name not
 * verified" wherever the Web App shows it. Real PostgreSQL 17 Control Store and
 * targets; every request of the browser is routed into the program in this
 * process.
 *
 * Ordering matters for one reason: the browser's virtual authenticator advances
 * the owner's credential counter, so everything that needs the test's own soft
 * authenticator (the registry setup, the client's consent) is done before the
 * browser signs in.
 */
const WEB_DIST =
  process.env['EXDB_TEST_WEB_DIST'] ?? fileURLToPath(new URL('../../web/dist/', import.meta.url))
const SHOTS = fileURLToPath(new URL('../test-results/web-cross-surface/', import.meta.url))
const SCOPES: Scope[] = [
  'targets.read',
  'schema.read',
  'migrations.read',
  'migrations.plan',
  'migrations.apply:nonprod',
  'migrations.apply:prod',
]
const CLIENT_NAME = 'Agent X-Surface <b>trusted</b>'
const UP = 'ALTER TABLE public.ledger ADD COLUMN settled_at timestamptz;\n'
const VERIFY =
  "-- check: settled_at exists\nSELECT count(*) = 1 AS ok FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ledger' AND column_name = 'settled_at';\n"

let w: McpWorld
let agent: McpCaller
let browser: Browser
let context: BrowserContext
let page: Page
let clientId: string
const dialogs: string[] = []
const cspViolations: string[] = []
const pageErrors: string[] = []
const project = { id: '', slug: 'ledger', displayName: 'Ledger' }
const databases = { staging: '', production: '' }

async function route(ctx: BrowserContext): Promise<void> {
  await ctx.route(`${ORIGIN}/**`, async (r) => {
    const request = r.request()
    const body = request.postDataBuffer()
    const served = await w.app.request(request.url(), {
      method: request.method(),
      headers: await request.allHeaders(),
      ...(body === null ? {} : { body }),
    })
    const headers: Record<string, string> = {}
    served.headers.forEach((value, name) => {
      if (name !== 'set-cookie') headers[name] = value
    })
    const cookies = served.headers.getSetCookie()
    if (cookies.length > 0) headers['set-cookie'] = cookies.join('\n')
    await r.fulfill({
      status: served.status,
      headers,
      body: Buffer.from(await served.arrayBuffer()),
    })
  })
}

/** Waits for `done`; when the page asks the person to confirm again first, answers with the passkey. */
async function withPasskeyIfAsked(done: Locator): Promise<void> {
  const reauth = page.locator('[role="dialog"][data-reauth]')
  await Promise.race([reauth.waitFor(), done.waitFor()])
  if (await reauth.isVisible()) await page.click('#reauth-passkey')
  await done.waitFor()
}

/** Confirms the plan dialog that is open: types the target path when the class asks for it. */
async function confirmPlanDialog(action: string, targetPath: string): Promise<void> {
  const dialog = page.getByRole('alertdialog')
  await dialog.waitFor()
  const typed = dialog.getByRole('textbox')
  if ((await typed.count()) > 0) await typed.first().fill(targetPath)
  await dialog.getByRole('button', { name: action, exact: true }).click()
}

/**
 * Registers `<slug>/ledger/<environment>` on the register page and applies the
 * registration plan on the plan review page (approving it first when the
 * server asks for a production approval).
 */
async function registerInWebApp(environment: 'staging' | 'production'): Promise<void> {
  const path = `${w.ids.slug}/${project.slug}/${environment}`
  await page.goto(`${ORIGIN}/targets/register`)
  await page.getByLabel('Product', { exact: true }).waitFor()
  await page.getByLabel('Product', { exact: true }).selectOption({ label: 'MCP E2E' })
  await page.getByLabel('Project', { exact: true }).selectOption({ label: project.displayName })
  await page
    .getByLabel('Environment', { exact: true })
    .selectOption({ label: environment === 'staging' ? 'Staging' : 'Production' })
  await page.getByLabel('Cluster', { exact: true }).selectOption({ label: `pg17 ${w.ids.slug}` })
  await page.getByLabel('Database', { exact: true }).selectOption({ label: databases[environment] })
  await page.getByRole('button', { name: 'Create registration plan' }).click()
  const dialog = page.getByRole('alertdialog')
  await dialog.waitFor()
  await dialog.getByRole('button', { name: 'Create plan', exact: true }).click()
  await Promise.race([
    page.waitForURL(/\/changes\/plans\/pln_/),
    page.locator('[role="dialog"][data-reauth]').waitFor(),
  ])
  if (await page.locator('[role="dialog"][data-reauth]').isVisible()) {
    await page.click('#reauth-passkey')
  }
  await page.waitForURL(/\/changes\/plans\/pln_/)
  await page.locator('.review .computed').waitFor()
  // The title says what happens: the target path as text.
  expect(await page.locator('h1').textContent()).toContain(path)

  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await confirmPlanDialog('Apply plan', path)
  await withPasskeyIfAsked(page.locator('p.status', { hasText: /^Operation op_/ }))
  if (environment === 'production') {
    // A registration on a production target waits for a person's approval; it is the person's
    // own plan here, so the self-approval is acknowledged explicitly.
    const acknowledge = page.getByRole('checkbox', { name: /This is my own plan/ })
    if ((await acknowledge.count()) > 0) await acknowledge.check()
    await page.getByRole('button', { name: 'Approve', exact: true }).click()
    await confirmPlanDialog('Approve plan', path)
    await withPasskeyIfAsked(page.locator('p.status', { hasText: /^Approved/ }))
  }
  await w.drive()
  await page.reload()
  await page.locator('li[data-indicator="apply"][data-outcome="applied"]').waitFor()
  await page.locator('li[data-indicator="verification"]').waitFor()
}

async function settle(operationId: string) {
  await w.drive()
  return (await agent.call('operation_get', { operationId })).structuredContent ?? {}
}

beforeAll(async () => {
  const web = await loadWebAssets([WEB_DIST])
  if (web === undefined) {
    throw new Error('the Web App is not built: run `bun run --cwd apps/web build` first')
  }
  await mkdir(SHOTS, { recursive: true })
  w = await mcpWorld('exdb_e2e_xsurface', { web })

  // The registry the person will extend in the browser: a project and two databases that exist on
  // the cluster and are known to it, but are not targets yet.
  const pg17 = serverFor(17)
  await w.planAndApply('/api/v1/projects', {
    product: w.ids.slug,
    slug: project.slug,
    displayName: project.displayName,
  })
  const projects = await w.owner.browser.call('GET', `/api/v1/projects?product=${w.ids.slug}`)
  project.id = projects.body.items.find((p: { slug: string }) => p.slug === project.slug).id
  await w.planAndApply(`/api/v1/projects/${project.id}/change-plans`, {
    executionRoles: { owner: OWNER_ROLE },
  })
  for (const environment of ['staging', 'production'] as const) {
    const database = await createDatabase(pg17, `${w.ids.slug}_ledger_${environment}`)
    await runAsSuperuser(pg17, database, [
      ...databaseBootstrapStatements(database),
      'CREATE TABLE public.ledger (id bigint PRIMARY KEY, amount numeric)',
      `ALTER TABLE public.ledger OWNER TO ${OWNER_ROLE}`,
      `GRANT USAGE, CREATE ON SCHEMA public TO ${OWNER_ROLE}`,
    ])
    await w.planAndApply(`/api/v1/clusters/${w.ids.cluster}/databases`, { name: database })
    databases[environment] = database
  }

  // The agent's grant covers every target of the product, including the two not registered yet.
  clientId = await w.mcpClient(CLIENT_NAME)
  agent = new McpCaller(
    w.app,
    (await w.mcpToken(clientId, SCOPES, ['nonprod', 'prod'])).access_token,
    'modern',
    { elicitation: { url: {} } },
  )

  browser = await chromium.launch({ headless: true })
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.addInitScript({
    content:
      "document.addEventListener('securitypolicyviolation', (e) => console.error('Content Security Policy violation: ' + e.violatedDirective + ' ' + e.blockedURI))",
  })
  await route(context)
  page = await context.newPage()
  page.on('dialog', (d) => {
    dialogs.push(d.message())
    void d.dismiss()
  })
  page.on('pageerror', (e) => pageErrors.push(e.message))
  page.on('console', (m) => {
    if (/Content.Security.Policy/i.test(m.text())) cspViolations.push(m.text())
  })
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable', { enableUI: false })
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  await cdp.send('WebAuthn.addCredential', {
    authenticatorId,
    credential: w.owner.authenticator.forVirtualAuthenticator(RP_ID),
  })
}, 300_000)

afterAll(async () => {
  await browser?.close()
  await w?.stop()
})

describe('one change across the Web App, MCP and the audit trail', () => {
  it('registers two targets in the Web App, plans over MCP, approves in the Web App, applies and verifies', async () => {
    await page.goto(`${ORIGIN}/login`)
    await page.click('#passkey-sign-in')
    await page.waitForURL(`${ORIGIN}/account`)

    // 1. Registration goes through the Web App: the page only creates a plan, the plan page
    //    applies it (no write path of its own).
    await registerInWebApp('staging')
    await registerInWebApp('production')
    await page.screenshot({ path: `${SHOTS}registered.png`, fullPage: true })
    const stagingPath = `${w.ids.slug}/${project.slug}/staging`
    const productionPath = `${w.ids.slug}/${project.slug}/production`
    const staging = await w.owner.browser.call(
      'GET',
      `/api/v1/targets/${encodeURIComponent(stagingPath)}`,
    )
    const production = await w.owner.browser.call(
      'GET',
      `/api/v1/targets/${encodeURIComponent(productionPath)}`,
    )
    expect([staging.status, production.status]).toEqual([200, 200])
    await w.observation.sampleHealth()

    // 2. The agent plans and proves the migration on the nonprod target, then plans production.
    const id = newUlid(Date.now())
    const staged = await agent.call('migration_plan', {
      target: stagingPath,
      bundles: [bundle({ id, name: 'add-settled-at', up: UP, verify: VERIFY })],
      defaults: DEFAULTS,
    })
    expect(staged.isError, staged.content[0]?.text.slice(0, 400)).toBeUndefined()
    const stagedOp = await agent.call('plan_apply', { planId: staged.structuredContent?.['id'] })
    expect(await settle(stagedOp.structuredContent?.['id'])).toMatchObject({ state: 'succeeded' })
    const planned = await agent.call('migration_plan', {
      target: productionPath,
      migrationIds: [id],
      defaults: DEFAULTS,
    })
    expect(planned.structuredContent).toMatchObject({ decision: 'require' })
    const plan = planned.structuredContent ?? {}
    const round = await agent.request('tools/call', {
      name: 'plan_apply',
      arguments: { planId: plan['id'] },
    })
    expect(round.body.result.resultType).toBe('input_required')
    const link = round.body.result.inputRequests.approval.params.url as string
    const operationId = link.split('#operation=')[1] ?? ''
    expect(operationId).toMatch(/^op_/)

    // 3. The person opens the link, reviews on the plan page and approves with a passkey.
    await page.goto(link)
    await page.waitForURL(`${ORIGIN}/changes/plans/${plan['id']}`)
    const card = page.locator(`li.card.focused[data-operation="${operationId}"]`)
    await card.locator('.review .computed').waitFor()
    expect(await page.locator('h1').textContent()).toContain(productionPath)
    // The client's own name, in the technical details: text, isolated, marked as not verified.
    const clientName = card.locator('.client-name [data-untrusted="name"]')
    expect(await clientName.locator('[dir="ltr"]').first().textContent()).toBe(CLIENT_NAME)
    expect(await clientName.textContent()).toContain('name not verified')
    expect(await card.locator('.review b').count()).toBe(0)
    expect(await card.locator('[data-plan-details] code.full-hash').textContent()).toBe(
      plan['planHash'],
    )
    // Nothing applied yet: the apply indicator is waiting, verification is pending.
    expect(await page.locator('li[data-indicator="apply"]').getAttribute('data-outcome')).not.toBe(
      'applied',
    )
    // The decision is in the page header, beside the title.
    await page
      .locator('[data-slot="page-header-actions"]')
      .getByRole('button', { name: 'Approve', exact: true })
      .click()
    await confirmPlanDialog('Approve plan', productionPath)
    await withPasskeyIfAsked(page.locator('p.status', { hasText: /^Approved/ }))

    // 4. The worker applies and verifies; applied and verified are two indicators.
    expect(await settle(operationId)).toMatchObject({
      state: 'succeeded',
      applyOutcome: 'applied',
      verificationOutcome: 'passed',
    })
    await page.goto(`${ORIGIN}/changes/operations/${operationId}`)
    const applied = page.locator('li[data-indicator="apply"]')
    const verified = page.locator('li[data-indicator="verification"]')
    await applied.waitFor()
    expect(await applied.getAttribute('data-outcome')).toBe('applied')
    expect(await applied.textContent()).toContain('Applied is not verified')
    expect(await verified.getAttribute('data-outcome')).toBe('passed')
    expect(await verified.textContent()).toContain('Verified')
    expect(await page.locator('li[data-indicator]').count()).toBe(2)
    // The operation page's own summary keeps the two outcomes apart as well.
    expect(await page.locator('span[data-indicator="apply"]').getAttribute('data-outcome')).toBe(
      'applied',
    )
    expect(
      await page.locator('span[data-indicator="verification"]').getAttribute('data-outcome'),
    ).toBe('passed')
    await page.screenshot({ path: `${SHOTS}operation.png`, fullPage: true })

    // 5. The audit page lists the approval and the apply of this target, with the client as
    //    text (its kind and id); the client's name is not an audit fact.
    const events = await w.owner.browser.call(
      'GET',
      `/api/v1/audit-events?target=${production.body.id}`,
    )
    expect(events.status, events.text).toBe(200)
    const actions = new Set<string>(events.body.items.map((e: { action: string }) => e.action))
    expect(actions.has('migration.apply')).toBe(true)
    // The approval is an event of the operation (its subject is the plan, not the target).
    const approvals = await w.owner.browser.call(
      'GET',
      '/api/v1/audit-events?action=approval.approve',
    )
    expect(approvals.status, approvals.text).toBe(200)
    const approvalEvent = approvals.body.items.find(
      (e: { refs: { operationId: string | null } }) => e.refs.operationId === operationId,
    )
    expect(approvalEvent, JSON.stringify(approvals.body).slice(0, 400)).toBeDefined()
    await page.goto(`${ORIGIN}/audit?target=${production.body.id}`)
    const table = page.locator('#audit-events')
    await table.waitFor()
    const rows = table.locator('tr[data-event]')
    const applyRow = rows.filter({ has: page.locator('code', { hasText: /^migration\.apply$/ }) })
    expect(await applyRow.count()).toBeGreaterThan(0)
    // The worker's completion has no client; the events the agent's client caused carry it (its
    // kind and ids: the audit page shows those, never the client's own name).
    const byClient = await w.owner.browser.call(
      'GET',
      `/api/v1/audit-events?client=${plan['clientId']}`,
    )
    expect(byClient.status, byClient.text).toBe(200)
    const byAgent = byClient.body.items.find(
      (e: { action: string; refs: { operationId: string | null } }) =>
        e.action === 'operation.accepted' && e.refs.operationId === operationId,
    )
    expect(byClient.body.items.some((e: { action: string }) => e.action === 'plan.created')).toBe(
      true,
    )
    expect(
      byAgent,
      JSON.stringify(
        byClient.body.items.map((e: { action: string; phase: string }) => [e.action, e.phase]),
      ),
    ).toBeDefined()
    await page.goto(`${ORIGIN}/audit?client=${plan['clientId']}`)
    await page.locator(`#audit-events tr[data-event="${byAgent.id}"]`).waitFor()
    await page
      .locator(`#audit-events tr[data-event="${byAgent.id}"]`)
      .getByRole('button', { name: /Show details of event/ })
      .click()
    const details = page.locator('#audit-event-details')
    expect(await details.textContent()).toContain(plan['clientId'] as string)
    expect(await details.textContent()).toContain('Through mcp')
    expect(await details.textContent()).toContain(plan['planHash'] as string)
    expect(await details.locator('a').count()).toBeGreaterThanOrEqual(2)
    // The plan approval, filtered by its action: one row for this operation, by the person.
    await page.goto(`${ORIGIN}/audit?action=approval.approve`)
    const approveRow = page.locator(`#audit-events tr[data-event="${approvalEvent.id}"]`)
    await approveRow.waitFor()
    expect(await approveRow.locator('code').first().textContent()).toBe('approval.approve')
    await approveRow.getByRole('button', { name: /Show details of event/ }).click()
    const open = page.locator('#audit-event-details').getByRole('link', { name: 'Open operation' })
    expect(await open.getAttribute('href')).toContain(operationId)
    await page.screenshot({ path: `${SHOTS}audit.png`, fullPage: true })

    // 6. The target's Activity page: the operation (applied and verified) and its audit events.
    await page.goto(`${ORIGIN}/t/${w.ids.slug}/${project.slug}/production/activity`)
    const operationRow = page.locator(`tr[data-operation="${operationId}"]`)
    await operationRow.waitFor()
    const cells = (await operationRow.locator('td').allTextContents()).join(' | ')
    expect(cells).toContain('succeeded')
    expect(cells).toContain('applied')
    expect(cells).toContain('passed')
    const auditItems = page.locator('li[data-audit]')
    await auditItems.first().waitFor()
    const auditText = (await auditItems.allTextContents()).join('\n')
    expect(auditText).toContain('migration.apply')
    await page.screenshot({ path: `${SHOTS}activity.png`, fullPage: true })

    // 7. The connected apps page names the client as untrusted text as well.
    await page.goto(`${ORIGIN}/access/oauth-clients`)
    const name = page.locator('[data-untrusted="name"]', { hasText: 'Agent X-Surface' }).first()
    await name.waitFor()
    expect(await name.textContent()).toContain('<b>trusted</b>')
    expect(await page.locator('main b').count()).toBe(0)

    expect(pageErrors).toEqual([])
    expect(dialogs).toEqual([])
  })

  it('ran into no Content Security Policy violation', () => {
    expect(cspViolations).toEqual([])
  })
})
