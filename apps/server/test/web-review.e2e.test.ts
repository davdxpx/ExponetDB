import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { systemClock } from '@exponetdb/kernel'
import { MetricsRegistry, silentLogger } from '@exponetdb/observability'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadWebAssets } from '../src/composition/access.ts'
import { createPublicApp, httpMetrics } from '../src/interfaces/http/app.ts'

/**
 * The approvals page's plan review and the consent page in a real Chromium
 * (Wave 7 order §24, §16), with hostile plan content: the built Web App is
 * served by the real HTTP surface in this process (every request of the
 * browser is routed into it), the API answers are fixed here. What a person
 * decides on must show the computed facts first, the raw text only as text
 * (no markup, no link, no script), every invisible or direction character
 * by its code point, and a DROP no filler can push out of sight.
 * Screenshots go to `test-results/web-review/` (not committed).
 */
const WEB_DIST = fileURLToPath(new URL('../../web/dist/', import.meta.url))
const SHOTS = fileURLToPath(new URL('../test-results/web-review/', import.meta.url))
const ORIGIN = 'https://db.example.test'
const OP = 'op_01M4S9000000000000000000AA'
const PLAN = 'pln_01M4S9000000000000000000AA'
const HASH = `sha256:ph1:${'ab'.repeat(32)}`
const MIGRATION = '01M4S9000000000000000000AB'
const TARGET = 'tgt_01M4S9000000000000000000AC'
const IDENTITY = 'idn_01M4S9000000000000000000AD'

const BIDI = '‮'
const TAG = String.fromCodePoint(0xe0041, 0xe0042)
const FILLER = Array.from({ length: 400 }, (_, i) => `-- filler line ${String(i)}`)
const UP_SQL = [
  "-- approved by security <script>window.__pwned = 1</script><img src=x onerror='window.__pwned=2'>",
  `-- [Approve now](https://evil.example/approve) https://evil.example/x ${BIDI}gnp.exe`,
  `ALTER TABLE public.accounts ADD COLUMN notes${TAG} text;`,
  ...FILLER,
  'DROP TABLE public.accounts;',
  `-- ${'z'.repeat(5000)}`,
].join('\n')

const ITEM = {
  operationId: OP,
  planId: PLAN,
  planHash: HASH,
  kind: 'migration.apply',
  class: 'high',
  tier: 'prod',
  actorIdentityId: IDENTITY,
  actorClient: 'mcp',
  requestedAt: '2026-10-13T08:00:00.000Z',
  ownPlan: true,
  approvals: [],
  required: 1,
  review: {
    clientName: 'ExponetDB Official ✅ <b>trusted</b>',
    sources: [
      {
        migrationId: MIGRATION,
        revision: 1,
        file: 'up.sql',
        text: UP_SQL,
        bytes: Buffer.byteLength(UP_SQL),
        truncated: false,
      },
    ],
    plan: {
      id: PLAN,
      kind: 'migration.apply',
      kindVersion: 1,
      class: 'high',
      state: 'active',
      planHash: HASH,
      createdAt: '2026-10-13T08:00:00.000Z',
      expiresAt: '2026-10-13T09:00:00.000Z',
      actor: { identityId: IDENTITY, kind: 'human', via: 'mcp' },
      clientId: 'cli_01M4S9000000000000000000AE',
      subject: {
        targetId: TARGET,
        targetPath: 'shop/platform/production',
        clusterId: null,
        nodeId: null,
        tier: 'prod',
      },
      contentChecksum: `sha256:${'cd'.repeat(32)}`,
      decision: 'require',
      requirements: [{ kind: 'approval', count: 1, permission: 'plans.approve' }],
      overriddenRules: [],
      approvals: { required: 1, given: 0 },
      policyRules: [
        {
          id: 'migration.agent-production',
          result: 'fail',
          severity: 'require',
          message: 'An agent changes production only with a human approval.',
          overridableByBreakGlass: false,
        },
      ],
      change: {
        content: {
          projectId: 'prj_01M4S9000000000000000000AF',
          migrations: [
            {
              migrationId: MIGRATION,
              name: 'add-notes',
              revision: 1,
              checksum: `sha256:c1:${'ef'.repeat(32)}`,
            },
          ],
          facts: { evidence: 'present' },
          expectedState: { schemaFingerprint: `sha256:fp1:${'01'.repeat(32)}` },
        },
        analysis: {
          perMigration: [
            {
              migrationId: MIGRATION,
              statements: [
                {
                  index: 0,
                  line: 3,
                  kind: 'ALTER TABLE',
                  compatibility: 'additive',
                  lock: { mode: 'ACCESS EXCLUSIVE', severity: 'brief', objects: [] },
                },
                {
                  index: 1,
                  line: 404,
                  kind: 'DROP TABLE',
                  compatibility: 'destructive',
                  lock: { mode: 'ACCESS EXCLUSIVE', severity: 'blocking', objects: [] },
                },
              ],
              compatibility: { declared: 'additive', observed: 'destructive', agreement: false },
              destructive: ['table public.accounts'],
              lockSeverity: 'blocking',
              rewriteRisk: [],
              rollback: { available: false, declaredSafety: null },
            },
          ],
          summary: {
            compatibility: 'destructive',
            lockSeverity: 'blocking',
            destructive: true,
            nontransactional: false,
          },
        },
      },
    },
  },
}

const CONSENT = {
  kind: 'authorization_code',
  client: {
    id: 'cli_01M4S9000000000000000000AE',
    clientId: 'https://agent.example/client.json',
    kind: 'mcp',
    registration: 'cimd',
    state: 'approved',
    firstParty: false,
    name: 'Agent <img src=x onerror=1>',
    redirectHost: 'agent.example',
    loopbackRedirect: false,
    lookalike: false,
  },
  resource: 'mcp',
  resourceUri: `${ORIGIN}/mcp`,
  scopes: [
    {
      scope: 'targets.read',
      available: true,
      reason: null,
      write: false,
      effect: 'read',
      tier: null,
      explicitConsent: false,
      humanOnly: false,
    },
    {
      scope: 'schema.read',
      available: true,
      reason: null,
      write: true,
      effect: 'control_record',
      tier: null,
      explicitConsent: false,
      humanOnly: false,
    },
  ],
  defaults: { tiers: ['nonprod'], targets: { kind: 'all' } },
  targets: [
    { id: TARGET, path: 'shop/platform/production', tier: 'prod' },
    { id: 'tgt_01M4S9000000000000000000AG', path: 'shop/platform/staging', tier: 'nonprod' },
  ],
  lifetimeDays: { default: 30, max: 90 },
  reauth: { fresh: true, withinSeconds: 300 },
  expiresAt: '2026-10-13T09:00:00.000Z',
}

let browser: Browser
let context: BrowserContext
let page: Page
const dialogs: string[] = []
const cspViolations: string[] = []
const consented: unknown[] = []
/** The consent view the stub serves (the trifecta case swaps it). */
let consentView: unknown = CONSENT

beforeAll(async () => {
  const web = await loadWebAssets([WEB_DIST])
  if (web === undefined) {
    throw new Error('the Web App is not built: run `bun run --cwd apps/web build` first')
  }
  const app = createPublicApp(
    {
      readiness: () => ({ status: 'ready', evaluatedAt: new Date().toISOString(), checks: [] }),
      version: '0.7.0-test',
      logger: silentLogger,
      metrics: httpMetrics(new MetricsRegistry()),
      clock: systemClock,
    },
    { web },
  )
  await mkdir(SHOTS, { recursive: true })
  browser = await chromium.launch({ headless: true })
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.route(`${ORIGIN}/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (url.pathname === '/api/v1/me') {
      return json({
        identity: { id: IDENTITY, label: 'human #1', state: 'active' },
        session: {},
        bindings: [],
        effectivePermissions: [],
      })
    }
    if (url.pathname === '/api/v1/approvals') return json({ items: [ITEM] })
    if (url.pathname === '/auth/oauth/consent/view') return json(consentView)
    if (url.pathname === '/auth/oauth/consent') {
      consented.push(request.postDataJSON())
      return json({ redirectTo: `${ORIGIN}/account` })
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
      return json({ code: 'NOT_FOUND' }, 404)
    }
    const served = await app.request(request.url(), { method: request.method() })
    return route.fulfill({
      status: served.status,
      headers: Object.fromEntries(served.headers),
      body: Buffer.from(await served.arrayBuffer()),
    })
  })
  page = await context.newPage()
  page.on('dialog', (d) => {
    dialogs.push(d.message())
    void d.dismiss()
  })
  page.on('console', (m) => {
    if (/Content.Security.Policy/i.test(m.text())) cspViolations.push(m.text())
  })
})

afterAll(async () => {
  await browser?.close()
})

describe('the plan review in Chromium', () => {
  it('shows the computed facts first and the raw text only as text', async () => {
    const response = await page.goto(`${ORIGIN}/approvals#operation=${OP}`)
    // The page is never framed; the operation id travels in the fragment (no Referer leak).
    expect(response?.headers()['content-security-policy']).toContain("frame-ancestors 'none'")
    await page.waitForSelector('.review')
    const review = page.locator('.review')
    // Facts ExponetDB computed: the target, production, the drop, the decision and its rule.
    const computed = review.locator('.computed')
    expect(await computed.textContent()).toContain('shop/platform/production')
    expect(await computed.locator('.badge.warn').first().textContent()).toBe('production')
    expect(await computed.locator('ul li.destructive').allTextContents()).toEqual([
      'table public.accounts',
    ])
    expect(await computed.textContent()).toContain(
      'declared additive, observed destructive (they disagree)',
    )
    // Every statement is listed with its line before any raw text: filler cannot hide the DROP.
    expect(await computed.locator('ol.statements li').allTextContents()).toEqual([
      'ALTER TABLE at line 3, lock ACCESS EXCLUSIVE, additive',
      'DROP TABLE at line 404, lock ACCESS EXCLUSIVE, destructive',
    ])
    expect(await computed.textContent()).toContain('migration.agent-production (require): fail.')
    expect(await computed.locator('code.full-hash').textContent()).toBe(HASH)
    // The client's own name: text, in quotes, marked as not verified.
    expect(await computed.locator('.client-name q').textContent()).toBe(
      'ExponetDB Official ✅ <b>trusted</b>',
    )
    expect(await computed.locator('.client-name .badge').textContent()).toBe('name not verified')

    // Nothing from the plan became markup: no script, image, link or bold element inside the review.
    for (const tag of ['script', 'img', 'a', 'b', 'iframe']) {
      expect(await review.locator(tag).count(), tag).toBe(0)
    }
    expect(await page.evaluate(() => (globalThis as { __pwned?: number }).__pwned)).toBeUndefined()
    expect(dialogs).toEqual([])

    // Every line numbered; the DROP at its line with its statement facts, never out of the list.
    const rows = review.locator('table.source-text tr')
    expect(await rows.count()).toBe(UP_SQL.split('\n').length)
    const drop = review.locator('tr.statement-start', { hasText: 'DROP TABLE public.accounts;' })
    expect(await drop.locator('td.line').textContent()).toBe('404')
    expect(await drop.locator('.badge.stmt').textContent()).toBe(
      '#2 DROP TABLE · lock ACCESS EXCLUSIVE · destructive',
    )
    // Direction and tag characters never act: they are shown by their code point.
    const raw = (await review.locator('table.source-text').textContent()) ?? ''
    expect(raw).not.toContain(BIDI)
    expect(raw).toContain('⟨U+202E⟩')
    expect(raw).toContain('⟨U+E0041⟩⟨U+E0042⟩')
    expect(raw).toContain('<script>window.__pwned = 1</script>')
    expect(await review.locator('.raw .banner.warn').first().textContent()).toMatch(
      /^\d+ character\(s\) are not plain ASCII/,
    )
    await page.screenshot({ path: `${SHOTS}approvals-hostile.png`, fullPage: true })
  })

  it('the consent page names the trifecta when production rows and changes are asked together', async () => {
    const scope = (name: string, effect: string) => ({
      scope: name,
      available: true,
      reason: null,
      write: effect !== 'read',
      effect,
      tier: 'prod',
      explicitConsent: true,
      humanOnly: false,
    })
    consentView = {
      ...CONSENT,
      scopes: [
        ...CONSENT.scopes,
        scope('data.read:prod', 'read'),
        scope('migrations.apply:prod', 'consequential'),
      ],
    }
    try {
      await page.goto(`${ORIGIN}/oauth/consent#request=exar_${'B'.repeat(43)}`)
      await page.waitForSelector('#consent-form')
      expect(await page.locator('#trifecta-warning').textContent()).toContain(
        'read production rows and to change databases',
      )
    } finally {
      consentView = CONSENT
      // A later visit must load the page again, not change the hash of this one.
      await page.goto('about:blank')
    }
  })

  it('the consent page shows what each scope does and lets a person pick targets', async () => {
    await page.goto(`${ORIGIN}/oauth/consent#request=exar_${'A'.repeat(43)}`)
    await page.waitForSelector('#consent-form')
    // Reads and records only: no trifecta warning.
    expect(await page.locator('#trifecta-warning').count()).toBe(0)
    const badges = await page.locator('#consent-form .badge').allTextContents()
    expect(badges).toContain('reads')
    expect(badges).toContain('records plans or checks, changes nothing')
    expect(badges).not.toContain('changes')
    expect(await page.locator('#consent-client img').count()).toBe(0)
    expect(await page.locator('#consent-client').textContent()).toContain(
      'Agent <img src=x onerror=1>',
    )
    // Only the staging target, for both tiers.
    await page.check('input[name="tier"][value="prod"]')
    await page.check('input[name="production"]')
    await page.check('input[name="where"][value="list"]')
    await page.check('input[name="target"][value="tgt_01M4S9000000000000000000AG"]')
    await page.screenshot({ path: `${SHOTS}consent-targets.png`, fullPage: true })
    await page.click('#consent-allow')
    await page.waitForURL(`${ORIGIN}/account`)
    expect(consented).toEqual([
      expect.objectContaining({
        decision: 'allow',
        tiers: ['nonprod', 'prod'],
        targets: { kind: 'list', targetIds: ['tgt_01M4S9000000000000000000AG'] },
      }),
    ])
  })

  it('ran into no Content Security Policy violation', () => {
    expect(cspViolations).toEqual([])
  })
})
