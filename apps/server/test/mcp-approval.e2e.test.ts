import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Scope } from '@exponetdb/contracts'
import { newUlid } from '@exponetdb/kernel'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadWebAssets } from '../src/composition/access.ts'
import { bundle, DEFAULTS, McpCaller, type McpWorld, mcpWorld } from './support/mcp-int-world.ts'
import { ORIGIN, RP_ID } from './support/node-world.ts'

/**
 * Approval from an MCP conversation, end to end in a real browser (Wave 7
 * order §24): an agent plans a migration over MCP, proves it on staging,
 * plans production and applies; the plan waits for a person, and a client
 * that declared URL elicitation receives the link as an elicitation. The
 * person opens the link in Chromium, signs in with their passkey (a
 * virtual authenticator holding the owner's credential), reviews what the
 * server computed and the statements verbatim, and approves; the worker
 * applies and verifies; the agent observes the verified result. Then the
 * refusals: a link alone gives nothing, an agent or a CLI token never
 * approves, a decision is not taken twice, and a revoked grant ends a
 * waiting operation. Real PostgreSQL 17 Control Store and targets; the
 * browser's requests are routed into the program in this process.
 */
const WEB_DIST = fileURLToPath(new URL('../../web/dist/', import.meta.url))
const SHOTS = fileURLToPath(new URL('../test-results/mcp-approval/', import.meta.url))
const SCOPES: Scope[] = [
  'targets.read',
  'schema.read',
  'migrations.read',
  'migrations.plan',
  'migrations.apply:nonprod',
  'migrations.apply:prod',
]
const UP = 'ALTER TABLE public.accounts ADD COLUMN reviewed text;\n'
const VERIFY =
  "-- check: reviewed exists\nSELECT count(*) = 1 AS ok FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'reviewed';\n"

let w: McpWorld
let clientId: string
let agent: McpCaller
let browser: Browser
let context: BrowserContext
let page: Page
const dialogs: string[] = []
const cspViolations: string[] = []

/** Routes every request of the browser for the origin into the program. */
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

async function settle(operationId: string) {
  await w.drive()
  return (await agent.call('operation_get', { operationId })).structuredContent ?? {}
}

/** Stages a migration on staging and plans production with it; returns the production plan. */
async function productionPlan(column: string) {
  const id = newUlid(Date.now())
  const staged = await agent.call('migration_plan', {
    target: w.ids.stagingTarget,
    bundles: [
      bundle({
        id,
        name: `add-${column}`,
        up: UP.replaceAll('reviewed', column),
        verify: VERIFY.replaceAll('reviewed', column),
      }),
    ],
    defaults: DEFAULTS,
  })
  expect(staged.isError, staged.content[0]?.text.slice(0, 400)).toBeUndefined()
  const op = await agent.call('plan_apply', { planId: staged.structuredContent?.['id'] })
  expect(await settle(op.structuredContent?.['id'])).toMatchObject({ state: 'succeeded' })
  const planned = await agent.call('migration_plan', {
    target: w.ids.productionTarget,
    migrationIds: [id],
    defaults: DEFAULTS,
  })
  expect(planned.structuredContent).toMatchObject({ decision: 'require' })
  return planned.structuredContent ?? {}
}

beforeAll(async () => {
  const web = await loadWebAssets([WEB_DIST])
  if (web === undefined) {
    throw new Error('the Web App is not built: run `bun run --cwd apps/web build` first')
  }
  await mkdir(SHOTS, { recursive: true })
  w = await mcpWorld('exdb_e2e_mcp', { web })
  clientId = await w.mcpClient('Agent E2E')
  agent = new McpCaller(
    w.app,
    (await w.mcpToken(clientId, SCOPES, ['nonprod', 'prod'])).access_token,
    'modern',
    { elicitation: { url: {} } },
  )
  browser = await chromium.launch({ headless: true })
  context = await browser.newContext()
  await route(context)
  page = await context.newPage()
  page.on('dialog', (d) => {
    dialogs.push(d.message())
    void d.dismiss()
  })
  page.on('console', (m) => {
    if (/Content.Security.Policy/i.test(m.text())) cspViolations.push(m.text())
  })
  // The owner's passkey in Chromium's virtual authenticator (presence and verification simulated).
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

describe('approval from MCP in a real browser', () => {
  it('an agent never approves, a CLI token never approves, a revoked grant ends the waiting operation', async () => {
    const plan = await productionPlan('rechecked')
    // A client without URL elicitation: the link in the result.
    const plain = new McpCaller(w.app, agent.token)
    const waiting = await plain.call('plan_apply', { planId: plan['id'] })
    const operationId = waiting.structuredContent?.['id'] as string
    expect(waiting.structuredContent?.['state']).toBe('awaiting_approval')

    // No approve tool exists, and an MCP token is not a credential of the REST API.
    const viaMcpToken = await w.app.request(`${ORIGIN}/api/v1/approvals/${operationId}/approve`, {
      method: 'POST',
      headers: { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ planHash: plan['planHash'] }),
    })
    expect(viaMcpToken.status).toBe(401)
    // The same person through the CLI: `plans.approve` is a Web App session scope, never
    // delegated, so a CLI token cannot approve.
    const cli = await w.apiToken(['migrations.read'], ['nonprod'])
    const viaCli = await w.rest(cli, 'POST', `/api/v1/approvals/${operationId}/approve`, {
      planHash: plan['planHash'],
      acknowledgeSelfApproval: true,
    })
    expect(viaCli.status).toBe(403)
    // A changed hash is refused, not taken over.
    await w.owner.reauth()
    const stale = await w.owner.browser.call('POST', `/api/v1/approvals/${operationId}/approve`, {
      planHash: `sha256:ph1:${'0'.repeat(64)}`,
      acknowledgeSelfApproval: true,
    })
    expect(stale.status).toBeGreaterThanOrEqual(400)

    // The person revokes the agent's grant; the approved operation never runs.
    const grants = await w.owner.browser.call('GET', '/api/v1/me/grants')
    const items = (grants.body.items ?? grants.body) as { id: string; client: { id: string } }[]
    const grant = items.find((g) => g.client.id === (plan['clientId'] as string))
    expect(grant).toBeDefined()
    const revoked = await w.owner.browser.call('POST', `/api/v1/me/grants/${grant?.id}/revoke`, {})
    expect(revoked.status, revoked.text).toBeLessThan(300)
    await w.owner.reauth()
    await w.owner.browser.call('POST', `/api/v1/approvals/${operationId}/approve`, {
      planHash: plan['planHash'],
      acknowledgeSelfApproval: true,
    })
    await w.drive()
    const after = await w.owner.browser.call('GET', `/api/v1/operations/${operationId}`)
    // The worker re-checks the applying client's grant at dispatch (E27): it never starts.
    expect(after.body, JSON.stringify(after.body).slice(0, 800)).toMatchObject({
      state: 'failed',
      applyOutcome: 'not_started',
    })
    expect(JSON.stringify(after.body)).toContain('GRANT_REVOKED')
    // And the agent's token is dead.
    const dead = await agent.request('tools/list')
    expect(dead.status).toBe(401)
  })

  it('the agent proposes, the person reviews and approves with a passkey, the agent observes the verified result', async () => {
    // A fresh grant (the refusals revoked the first one), minted before the browser uses the
    // owner's passkey: the virtual authenticator advances the credential's signature counter.
    agent = new McpCaller(
      w.app,
      (await w.mcpToken(clientId, SCOPES, ['nonprod', 'prod'])).access_token,
      'modern',
      { elicitation: { url: {} } },
    )
    const plan = await productionPlan('reviewed')
    // The client declared URL elicitation: the link arrives as one, the operation already exists.
    const round = await agent.request('tools/call', {
      name: 'plan_apply',
      arguments: { planId: plan['id'] },
    })
    expect(round.body.result.resultType).toBe('input_required')
    const url = round.body.result.inputRequests.approval.params.url as string
    expect(url).toMatch(new RegExp(`^${ORIGIN}/approvals#operation=op_[0-9A-HJKMNP-TV-Z]{26}$`))
    const operationId = url.split('#operation=')[1] ?? ''

    // A browser without a session learns nothing from the link: it is sent to sign in.
    const stranger = await browser.newContext()
    await route(stranger)
    const strangerPage = await stranger.newPage()
    await strangerPage.goto(url)
    await strangerPage.waitForURL(/\/login(\?|$)/)
    expect(await strangerPage.content()).not.toContain(operationId)
    await stranger.close()

    // The person signs in with the passkey and opens the link the agent showed.
    await page.goto(`${ORIGIN}/login`)
    await page.click('#passkey-sign-in')
    await page.waitForURL(`${ORIGIN}/account`)
    await page.goto(url)
    const card = page.locator(`li.card.focused[data-operation="${operationId}"]`)
    await card.locator('.review').waitFor()
    const computed = (await card.locator('.review .computed').textContent()) ?? ''
    expect(computed).toContain(`${w.ids.slug}/platform/production`)
    expect(computed).toContain('Staging evidencepresent')
    expect(await card.locator('.client-name q').textContent()).toBe('Agent E2E')
    expect(await card.locator('.client-name .badge').textContent()).toBe('name not verified')
    expect(await card.locator('code.full-hash').textContent()).toBe(plan['planHash'])
    expect(await card.locator('table.source-text td.text').first().textContent()).toContain(
      'ALTER TABLE public.accounts ADD COLUMN reviewed text;',
    )
    await page.screenshot({ path: `${SHOTS}approval-review.png`, fullPage: true })

    // An agent proposed it: the card says so; approving it is the person's decision, not a
    // self-approval of their own plan (OD-9, G3A case 1), so no self-approval box is shown.
    expect(await card.locator(`#agent-note-${operationId}`).textContent()).toContain(
      'the agent cannot approve',
    )
    expect(await card.locator('input[name="acknowledge"]').count()).toBe(0)
    await card.getByRole('button', { name: 'Approve' }).click()
    const reauth = page.locator('dialog.reauth[open]')
    const done = page.locator('p.status', { hasText: /^Approved/ })
    await Promise.race([reauth.waitFor(), done.waitFor()])
    if (await reauth.isVisible()) await page.click('#reauth-passkey')
    await done.waitFor()

    // The worker applies and verifies; the agent sees verified, never just applied.
    expect(await settle(operationId)).toMatchObject({
      state: 'succeeded',
      applyOutcome: 'applied',
      verificationOutcome: 'passed',
    })
    // Decided once: approving again is refused.
    const again = await w.owner.browser.call('POST', `/api/v1/approvals/${operationId}/approve`, {
      planHash: plan['planHash'],
    })
    expect(again.status).toBeGreaterThanOrEqual(400)
    expect(dialogs).toEqual([])
  })

  it('ran into no Content Security Policy violation', () => {
    expect(cspViolations).toEqual([])
  })
})
