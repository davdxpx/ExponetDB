import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Scope } from '@exponetdb/contracts'
import { newUlid } from '@exponetdb/kernel'
import { runAsSuperuser, serverFor } from '@exponetdb/testkit'
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
 * Hostile content through every surface that shows it, in a real browser (Wave 8
 * order section 10, Phase 15). Names and text carrying markup, a bidi override,
 * tag characters, zero-width characters and a DROP hidden in a long line are
 * seeded where the API or the database allows: the MCP client's name (DCR), a
 * migration's up.sql, a table and a column of the target (direct SQL), and an
 * audit reason (disabling an identity). The Web App must show all of it as text:
 * no element created from content, nothing executed, the invisible characters
 * shown by their code points, and no Content Security Policy violation.
 */
const WEB_DIST =
  process.env['EXDB_TEST_WEB_DIST'] ?? fileURLToPath(new URL('../../web/dist/', import.meta.url))
const SHOTS = fileURLToPath(new URL('../test-results/web-hostile/', import.meta.url))
const SCOPES: Scope[] = [
  'targets.read',
  'schema.read',
  'migrations.read',
  'migrations.plan',
  'migrations.apply:nonprod',
  'migrations.apply:prod',
]
const BIDI = '\u202E'
const TAG = String.fromCodePoint(0xe0041, 0xe0042)
const ZERO_WIDTH = '\u200B\u200D\uFEFF'
const hostile = (label: string): string =>
  `${label}<script>window.__pwned=1</script><img src=x onerror="window.__pwned=2">${BIDI}gnp.exe${TAG}${ZERO_WIDTH}`
const CLIENT_NAME = hostile('Agent')
// Identifiers are limited to 63 bytes and a quoted one cannot hold a double quote.
const identifier = (label: string): string =>
  `${label}<script>alert(1)</script>${BIDI}${TAG}${ZERO_WIDTH}`
const TABLE = identifier('tbl')
const COLUMN = identifier('col')
const REASON = hostile('Disabled because')
const LONG = `-- ${'a'.repeat(3000)} DROP TABLE public.accounts;`
const UP = [
  '-- approved by security <script>window.__pwned=3</script> [Approve now](https://evil.example/a)',
  `-- ${BIDI}gnp.exe${TAG}${ZERO_WIDTH}`,
  LONG,
  'ALTER TABLE public.accounts ADD COLUMN checked boolean;',
  '',
].join('\n')
const VERIFY =
  "-- check: checked exists\nSELECT count(*) = 1 AS ok FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'checked';\n"

let w: McpWorld
let agent: McpCaller
let browser: Browser
let context: BrowserContext
let page: Page
const dialogs: string[] = []
const cspViolations: string[] = []
const pageErrors: string[] = []

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

/** Nothing on the page was made from content: no inline script, no foreign element, nothing ran. */
async function expectInert(where: string): Promise<void> {
  const facts = {
    pwned: await page.evaluate(() => (globalThis as { __pwned?: number }).__pwned),
    inlineScripts: await page.locator('script:not([src])').count(),
    foreign: await page.locator('main img, main iframe, main object, main embed, main b').count(),
    handlers: await page.locator('[onerror], [onclick], [onload]').count(),
  }
  expect(facts, where).toEqual({ pwned: undefined, inlineScripts: 0, foreign: 0, handlers: 0 })
}

/** The page's visible text. */
async function bodyText(): Promise<string> {
  return (await page.locator('body').textContent()) ?? ''
}

async function visit(path: string): Promise<void> {
  await page.goto(`${ORIGIN}${path}`)
  await page.locator('main').waitFor()
}

beforeAll(async () => {
  const web = await loadWebAssets([WEB_DIST])
  if (web === undefined) {
    throw new Error('the Web App is not built: run `bun run --cwd apps/web build` first')
  }
  await mkdir(SHOTS, { recursive: true })
  w = await mcpWorld('exdb_e2e_hostile', { web })

  // Hostile identifiers in the targets themselves (the one place only SQL can put them).
  const pg17 = serverFor(17)
  for (const database of [w.ids.stagingDatabase, w.ids.productionDatabase]) {
    await runAsSuperuser(pg17, database, [
      `CREATE TABLE public."${TABLE}" (id bigint PRIMARY KEY, "${COLUMN}" text)`,
      `COMMENT ON COLUMN public."${TABLE}"."${COLUMN}" IS '${hostile('comment').replaceAll("'", "''")}'`,
      `ALTER TABLE public."${TABLE}" OWNER TO ${OWNER_ROLE}`,
    ])
  }

  // An audit reason: a person is invited and disabled with a hostile reason.
  await w.owner.reauth()
  const invited = await w.owner.browser.call('POST', '/api/v1/identities', {
    email: 'hostile@example.test',
  })
  expect(invited.status, invited.text).toBe(201)
  await w.owner.reauth()
  const disabled = await w.owner.browser.call(
    'POST',
    `/api/v1/identities/${invited.body.identity?.id ?? invited.body.id}/disable`,
    { reason: REASON },
  )
  expect(disabled.status, disabled.text).toBeLessThan(300)
  await w.drive()

  const clientId = await w.mcpClient(CLIENT_NAME)
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

describe('hostile content in every surface that shows it', () => {
  it('shows names, SQL, reasons and identifiers as text only, with invisible characters named', async () => {
    const stagingPath = `${w.ids.slug}/platform/staging`
    const productionPath = `${w.ids.slug}/platform/production`
    const id = newUlid(Date.now())
    const staged = await agent.call('migration_plan', {
      target: stagingPath,
      bundles: [bundle({ id, name: 'add-checked', up: UP, verify: VERIFY })],
      defaults: DEFAULTS,
    })
    expect(staged.isError, staged.content[0]?.text.slice(0, 400)).toBeUndefined()
    const stagedOp = await agent.call('plan_apply', { planId: staged.structuredContent?.['id'] })
    await w.drive()
    expect(
      (await agent.call('operation_get', { operationId: stagedOp.structuredContent?.['id'] }))
        .structuredContent,
    ).toMatchObject({ state: 'succeeded' })
    const planned = await agent.call('migration_plan', {
      target: productionPath,
      migrationIds: [id],
      defaults: DEFAULTS,
    })
    const plan = planned.structuredContent ?? {}
    const round = await agent.request('tools/call', {
      name: 'plan_apply',
      arguments: { planId: plan['id'] },
    })
    const link = round.body.result.inputRequests.approval.params.url as string
    const operationId = link.split('#operation=')[1] ?? ''
    expect(operationId).toMatch(/^op_/)

    await page.goto(`${ORIGIN}/login`)
    await page.click('#passkey-sign-in')
    await page.waitForURL(`${ORIGIN}/account`)

    // Plan review (the approvals link): the up.sql is text, the DROP in the long line is visible
    // as part of the comment, the invisible characters are named, the client name is not verified.
    await page.goto(link)
    await page.waitForURL(`${ORIGIN}/changes/plans/${plan['id']}`)
    const card = page.locator(`li.card.focused[data-operation="${operationId}"]`)
    await card.locator('.review .computed').waitFor()
    await expectInert('plan review')
    const review = (await card.textContent()) ?? ''
    expect(review).toContain('<script>window.__pwned=3</script>')
    expect(review).toContain('⟨U+202E⟩')
    expect(review).toContain('⟨U+E0041⟩')
    expect(review).toContain('⟨U+200B⟩')
    expect(review).toContain('DROP TABLE public.accounts;')
    const clientName = card.locator('.client-name')
    expect(await clientName.textContent()).toContain('name not verified')
    expect(await clientName.textContent()).toContain('⟨U+202E⟩')
    await page.screenshot({ path: `${SHOTS}plan-review.png`, fullPage: true })

    await visit('/approvals')
    await page.locator(`[data-operation="${operationId}"]`).first().waitFor()
    // The list carries facts only (kind, class, tier, target); the plan's text is on the review.
    await expectInert('approvals')

    // Approve in the Web App so the remaining pages have an applied operation to show.
    await page.goto(link)
    const again = page.locator(`li.card.focused[data-operation="${operationId}"]`)
    await again.locator('.review .computed').waitFor()
    // The decision is in the page header, beside the title.
    await page
      .locator('[data-slot="page-header-actions"]')
      .getByRole('button', { name: 'Approve', exact: true })
      .click()
    await confirmPlanDialog('Approve plan', productionPath)
    await withPasskeyIfAsked(page.locator('p.status', { hasText: /^Approved/ }))
    await w.drive()

    await visit(`/changes/operations/${operationId}`)
    await page.locator('li[data-indicator="apply"]').waitFor()
    await expectInert('operation')

    // Schema: the hostile table and column are names, not markup.
    await visit(`/t/${w.ids.slug}/platform/production/schema/tables`)
    await page.getByLabel('Filter by name').fill('tbl')
    await page.getByRole('button', { name: 'Show matching objects' }).click()
    await page.getByText('⟨U+202E⟩').first().waitFor()
    await expectInert('schema tables')
    expect(await bodyText()).toContain('<script>alert(1)</script>')
    await page.screenshot({ path: `${SHOTS}schema.png`, fullPage: true })

    // Activity of the target and the installation-wide audit log.
    await visit(`/t/${w.ids.slug}/platform/production/activity`)
    await page.locator(`tr[data-operation="${operationId}"]`).waitFor()
    await expectInert('activity')
    await visit('/audit?action=access.identity.disable')
    const reasonRow = page.locator('#audit-events tr[data-event]').first()
    await reasonRow.waitFor()
    await reasonRow.getByRole('button', { name: /Show details of event/ }).click()
    await page.locator('#audit-event-details').waitFor()
    await expectInert('audit')
    const detail = (await page.locator('#audit-event-details').textContent()) ?? ''
    expect(detail).toContain('<script>window.__pwned=1</script>')
    expect(detail).toContain('⟨U+202E⟩')
    await page.screenshot({ path: `${SHOTS}audit.png`, fullPage: true })

    // The client's name, in the OAuth client list and in the connected apps.
    await visit('/access/oauth-clients')
    await page.locator('[data-untrusted="name"]', { hasText: 'Agent' }).first().waitFor()
    await expectInert('oauth clients')
    expect(await bodyText()).toContain('⟨U+202E⟩')
    await visit('/access/connected-apps')
    await page.locator('main').getByText('Agent').first().waitFor()
    await expectInert('connected apps')
    expect(await bodyText()).toContain('⟨U+202E⟩')
    await page.screenshot({ path: `${SHOTS}connected-apps.png`, fullPage: true })

    expect(pageErrors).toEqual([])
    expect(dialogs).toEqual([])
  })

  it('ran into no Content Security Policy violation', () => {
    expect(cspViolations).toEqual([])
  })
})
