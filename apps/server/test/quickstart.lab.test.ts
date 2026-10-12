import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { totpCodeAt } from '@exponetdb/auth'
import { Secret } from 'otpauth'
import {
  type Browser,
  type BrowserContext,
  type CDPSession,
  chromium,
  type Page,
} from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The CLI quickstart, executed (order §62, §63, §68;
 * [`15-cli/quickstart.md`](../../../exponetdb-docs/15-cli/quickstart.md)):
 * the installed CLI (`EXDB_CLI_BIN`, the packed artifact) against a local
 * lab of the ExponetDB image (`EXDB_LAB_IMAGE`), with a real Chromium and a
 * virtual passkey for what a person does in the browser: the first-owner
 * setup, the sign-in consent, the write-only credential form, step-up
 * confirmations and approvals. Every registry, credential, migration and
 * approval step goes through the CLI and the REST API; the test reads a
 * database only to check independently.
 *
 * Never skipped: without the image, the installed CLI, Docker or Chromium
 * it fails.
 */
const BIN = process.env['EXDB_CLI_BIN'] ?? ''
const IMAGE = process.env['EXDB_LAB_IMAGE'] ?? ''
const TRANSCRIPT = process.env['EXDB_QUICKSTART_TRANSCRIPT']
/** Where to keep the lab's export (role logs, run records) after `dev destroy`. */
const EXPORTS = process.env['EXDB_QUICKSTART_EXPORTS']
const LAB = `qs${Date.now().toString(36).slice(-5)}`
const EMAIL = 'owner@example.test'
const PASSWORD = 'tangerine fjord radiator 42'
const SCOPES =
  'targets.read registry.manage nodes.read migrations.read migrations.plan migrations.apply:nonprod migrations.apply:prod schema.read diagnostics.read audit.read'

let home = ''
let project = ''
let port = 0
let origin = ''
let browser: Browser
let context: BrowserContext
let page: Page
let cdp: CDPSession
let totpSecret = ''
let lastTotpStep = 0

interface Step {
  readonly command: string
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}
const transcript: Step[] = []
/** Role passwords per cluster, generated here, never printed by the CLI. */
const passwords = new Map<string, string>()

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      const p = typeof a === 'object' && a !== null ? a.port : 0
      s.close(() => resolve(p))
    })
  })
}

/** A TOTP code for a step the server has not seen yet (codes are single-use per step). */
function nextTotp(): string {
  const now = Math.floor(Date.now() / 30_000)
  const step = Math.max(now, lastTotpStep + 1)
  lastTotpStep = step
  return totpCodeAt(Secret.fromBase32(totpSecret).bytes, step * 30_000)
}

async function confirmWithPasskey(): Promise<void> {
  await page.waitForSelector('dialog.reauth[open]', { timeout: 15_000 })
  await page.click('#reauth-passkey')
  await page.waitForSelector('dialog.reauth[open]', { state: 'detached', timeout: 15_000 })
}

/**
 * Waits for `done`; if the server asks for a fresh proof first (the
 * re-authentication dialog), confirms it with the passkey. A proof that is
 * still fresh needs no dialog.
 */
async function untilDone(done: string): Promise<void> {
  const first = await Promise.race([
    page.waitForSelector(done, { timeout: 30_000 }).then(() => 'done' as const),
    page.waitForSelector('dialog.reauth[open]', { timeout: 30_000 }).then(() => 'reauth' as const),
  ])
  if (first === 'reauth') {
    await page.click('#reauth-passkey')
    await page.waitForSelector(done, { timeout: 30_000 })
  }
}

/**
 * Runs the installed CLI as a process. While it runs, the browser does
 * what the CLI asks a person to do: sign in, confirm a step-up with the
 * code shown, approve a plan, or enter a role password.
 */
async function exdb(
  args: readonly string[],
  options: { readonly stdin?: string; readonly record?: string; readonly cwd?: string } = {},
): Promise<Step> {
  const child = spawn(BIN, [...args], {
    cwd: options.cwd ?? project,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: home,
      EXPONETDB_CONFIG_DIR: join(home, 'config'),
      NO_COLOR: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.end(options.stdin ?? '')
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (d: string) => {
    stdout += d
  })
  child.stderr.setEncoding('utf8').on('data', (d: string) => {
    stderr += d
  })
  let exited = false
  const done = new Promise<number>((resolve) => {
    child.on('close', (code) => {
      exited = true
      resolve(code ?? -1)
    })
  })
  const handled = new Set<string>()
  while (!exited) {
    const login = /Sign in at: (\S+)/.exec(stderr)
    if (login?.[1] !== undefined && !handled.has(login[1])) {
      handled.add(login[1])
      await page.goto(login[1])
      await page.waitForSelector('#consent-form')
      // Administrative and production scopes are opt-in: the person ticks each.
      for (const box of await page
        .locator('#consent-form input[name="scope"]:not([disabled])')
        .all()) {
        await box.check()
      }
      await page.check('#consent-form input[name="tier"][value="prod"]')
      await page.check('#consent-form input[name="production"]')
      await page.click('#consent-allow')
      // Production and administrative scopes ask for a fresh passkey first.
      const reauth = await page
        .waitForSelector('dialog.reauth[open]', { timeout: 5_000 })
        .then(() => true)
        .catch(() => false)
      if (reauth) await confirmWithPasskey()
      await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/callback\?/)
    }
    const stepUp = /Open (\S+\/step-up#id=stu_[0-9A-Z]{26})\nCode: ([A-Z0-9-]+)/.exec(stderr)
    if (stepUp?.[1] !== undefined && !handled.has(stepUp[1])) {
      handled.add(stepUp[1])
      await page.goto(stepUp[1])
      await page.waitForSelector('#step-up-code')
      await page.fill('#step-up-code', stepUp[2] ?? '')
      await page.click('#step-up button.primary')
      await untilDone('#step-up-done')
    }
    const approval = /Approval needed: (\S+\/approvals#operation=(op_[0-9A-Z]{26}))/.exec(stderr)
    if (approval?.[1] !== undefined && !handled.has(approval[1])) {
      handled.add(approval[1])
      await page.goto(approval[1])
      const card = page.locator(`li[data-operation="${approval[2]}"]`)
      await card.waitFor()
      if ((await card.locator('input[name="acknowledge"]').count()) > 0) {
        await card.locator('input[name="acknowledge"]').check()
      }
      await card.locator('button.primary').click()
      await untilDone('p.status:has-text("Approved")')
    }
    const credential =
      /Enter the (\w+) password at: (\S+\/credentials#cluster=(cls_[0-9A-Z]{26})&role=\w+)/.exec(
        stderr,
      )
    if (credential?.[2] !== undefined && !handled.has(credential[2])) {
      handled.add(credential[2])
      const secret = passwords.get(`${credential[3]}/${credential[1]}`) ?? ''
      await page.goto(credential[2])
      await page.waitForSelector('#credential-password')
      await page.fill('#credential-password', secret)
      await page.fill('#credential-confirm', secret)
      await page.click('#credential-submit')
      await untilDone('p.status:has-text("Submitted")')
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  const step: Step = {
    command: `exponetdb ${options.record ?? args.join(' ')}`,
    code: await done,
    stdout,
    stderr,
  }
  // The transcript is evidence to keep: a SCRAM verifier the CLI printed on
  // request (--stdout) is replaced, never stored with it.
  transcript.push({
    ...step,
    stdout: step.stdout.replace(/SCRAM-SHA-256\$[^\s'"]+/g, '<scram verifier>'),
  })
  // No secret the test generated ever appears in what the CLI printed.
  for (const p of passwords.values()) expect(`${stdout}${stderr}`).not.toContain(p)
  return step
}

const data = (s: Step) => JSON.parse(s.stdout).data

async function ok(args: readonly string[], options?: Parameters<typeof exdb>[1]): Promise<Step> {
  const s = await exdb(args, options)
  expect(s.code, `${s.command}\n${s.stdout}\n${s.stderr}`).toBe(0)
  return s
}

beforeAll(async () => {
  expect(BIN, 'EXDB_CLI_BIN names the installed CLI').not.toBe('')
  expect(IMAGE, 'EXDB_LAB_IMAGE names the ExponetDB image').not.toBe('')
  home = await realpath(await mkdtemp(join(tmpdir(), 'exdb-quickstart-')))
  await mkdir(join(home, 'config'), { mode: 0o700 })
  project = join(home, 'shop')
  await mkdir(project)
  port = await freePort()
  origin = `http://localhost:${port}`
  browser = await chromium.launch({ headless: true })
  context = await browser.newContext()
  page = await context.newPage()
  cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable', { enableUI: false })
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
}, 120_000)

afterAll(async () => {
  if (TRANSCRIPT !== undefined) {
    await writeFile(
      TRANSCRIPT,
      `${JSON.stringify(
        transcript.map((s) => ({
          ...s,
          stdout: s.stdout.slice(0, 4000),
          stderr: s.stderr.slice(0, 2000),
        })),
        null,
        2,
      )}\n`,
    )
  }
  await browser?.close()
  if (BIN !== '' && home !== '') {
    await exdb(['dev', 'destroy', '--lab', LAB, '--yes']).catch(() => undefined)
    if (EXPORTS !== undefined) {
      await cp(join(home, 'config', 'lab-exports'), EXPORTS, { recursive: true }).catch(
        () => undefined,
      )
    }
  }
  if (home !== '') await rm(home, { recursive: true, force: true })
}, 300_000)

const ids = {
  product: '',
  staging: '',
  production: '',
  project: '',
  clusters: {} as Record<'staging' | 'production', string>,
  databases: {} as Record<'staging' | 'production', string>,
}

describe('the quickstart with the installed CLI', () => {
  it('installs: version and help without a server', async () => {
    expect((await ok(['--version'])).stdout).toMatch(/^exponetdb \d+\.\d+\.\d+ \(/)
    expect((await ok(['--help'])).stdout).toContain('Local test lab:')
  })

  it('starts a lab and a profile for it', async () => {
    const up = await ok(
      ['dev', 'up', '--lab', LAB, '--image', IMAGE, '--port', String(port), '--json'],
      {
        record: `dev up --lab ${LAB} --image <image> --port ${port} --json`,
      },
    )
    expect(data(up)).toMatchObject({ ready: true, server: origin })
    await ok(['profile', 'add', 'lab', '--server', origin, '--use'])
  })

  it('sets up the first owner in the browser and signs the CLI in', async () => {
    await ok(['dev', 'owner', '--lab', LAB, '--email', EMAIL])
    const link = (
      await readFile(join(home, 'config', 'labs', LAB, 'secrets', 'owner-setup-link'), 'utf8')
    ).trim()
    await page.goto(link)
    await page.waitForSelector('#create-passkey')
    await page.click('#create-passkey')
    await page.waitForSelector('li.step.done >> text=Passkey')
    await page.fill('#set-password input[name="password"]', PASSWORD)
    await page.fill('#set-password input[name="confirm"]', PASSWORD)
    await page.click('#set-password button[type="submit"]')
    await page.waitForSelector('li.step.done >> text=Password')
    await page.click('#setup-totp')
    await page.waitForSelector('svg.qr')
    totpSecret = (await page.textContent('#totp-secret'))?.replaceAll(' ', '') ?? ''
    await page.fill('#confirm-totp input[name="code"]', nextTotp())
    await page.click('#confirm-totp button[type="submit"]')
    await page.waitForSelector('li.step.done >> text=Authenticator app')
    await page.click('#finish')
    await page.waitForSelector('#recovery-codes li')
    await page.check('#codes-stored')
    await page.click('#continue')
    await page.waitForURL(`${origin}/account`)

    const login = await ok(['login', '--no-browser', '--scope', SCOPES], {
      record: `login --scope "${SCOPES}"`,
    })
    expect(login.stdout).toContain(`Signed in to ${origin}`)
    const me = data(await ok(['whoami', '--json']))
    expect(me.scope.split(' ')).toEqual(
      expect.arrayContaining(['registry.manage', 'migrations.apply:prod']),
    )
    const doctor = await exdb(['doctor', '--json'])
    const checks = Object.fromEntries(
      data(doctor).items.map((c: { check: string; status: string }) => [c.check, c.status]),
    )
    expect(checks).toMatchObject({ server: 'ok', 'sign-in': 'ok' })
  })

  it('reads an empty registry: valid empty lists, never an error', async () => {
    for (const command of [
      ['product', 'list'],
      ['target', 'list'],
      ['node', 'list'],
      ['cluster', 'list'],
    ]) {
      const s = await ok([...command, '--json'])
      expect(data(s).items).toEqual([])
    }
  })

  it('registers a product, its environments and a project through plans', async () => {
    await ok(['product', 'create', 'shop', '--name', 'Shop', '--apply'])
    ids.product = data(await ok(['product', 'show', 'shop', '--json'])).id
    await ok([
      'environment',
      'create',
      'shop',
      'staging',
      '--name',
      'Staging',
      '--tier',
      'nonprod',
      '--apply',
    ])
    await ok([
      'environment',
      'create',
      'shop',
      'production',
      '--name',
      'Production',
      '--tier',
      'prod',
      '--evidence-from',
      'staging',
      '--apply',
      '--yes',
    ])
    for (const e of data(await ok(['environment', 'list', 'shop', '--json'])).items) {
      if (e.slug === 'staging') ids.staging = e.id
      if (e.slug === 'production') ids.production = e.id
    }
    await ok(['project', 'create', 'shop', 'platform', '--name', 'Platform', '--apply'])
    ids.project = data(await ok(['project', 'list', '--json'])).items[0].id
    expect(ids.project).toMatch(/^prj_/)
  })

  for (const env of ['staging', 'production'] as const) {
    it(`registers the ${env} cluster, its roles, credentials and database`, async () => {
      const status = data(await ok(['dev', 'status', '--lab', LAB, '--json']))
      const host = status.targets.find((t: { role: string }) => t.role === env).host as string
      expect(host).toBe(`${env}.${LAB}.exdb-lab.test`)
      // The lab's database server: an application database and its roles (lab superuser).
      await ok(['dev', 'sql', env, '--lab', LAB], {
        stdin:
          'CREATE ROLE app_migrator NOLOGIN;\nCREATE ROLE app_user NOLOGIN;\nCREATE DATABASE app;\n',
        record: `dev sql ${env} --lab ${LAB}   # CREATE ROLE app_migrator …; CREATE DATABASE app;`,
      })
      await ok(['dev', 'sql', env, '--lab', LAB, '--db', 'app'], {
        stdin: 'GRANT CREATE, USAGE ON SCHEMA public TO app_migrator;\n',
        record: `dev sql ${env} --lab ${LAB} --db app   # GRANT CREATE, USAGE ON SCHEMA public TO app_migrator;`,
      })
      const ca = await readFile(join(home, 'config', 'labs', LAB, 'tls', `${env}-ca.crt`), 'utf8')
      await writeFile(
        join(project, `cluster-${env}.yaml`),
        [
          `displayName: lab ${env}`,
          'caBundle: |',
          ...ca
            .trim()
            .split('\n')
            .map((l) => `  ${l}`),
          'endpoints:',
          '  - kind: private',
          `    host: ${host}`,
          '    port: 5432',
          `    tlsServerName: ${host}`,
          '    label: direct',
          '',
        ].join('\n'),
      )
      await ok(['cluster', 'register', '--file', `cluster-${env}.yaml`, '--apply'])
      const cluster = data(await ok(['cluster', 'list', '--json'])).items.find(
        (c: { displayName: string }) => c.displayName === `lab ${env}`,
      ).id as string
      ids.clusters[env] = cluster
      // The roles, from the server's bootstrap SQL, run by the lab's superuser.
      await ok(['cluster', 'bootstrap-sql', cluster, '--file', `bootstrap-${env}.sql`])
      await ok(['dev', 'sql', env, '--lab', LAB, '--file', `bootstrap-${env}.sql`])
      // Passwords chosen here; only SCRAM verifiers reach the database.
      const statements = ['GRANT app_migrator TO exponetdb_migrator WITH INHERIT FALSE, SET TRUE;']
      for (const role of ['observer', 'migrator', 'reader', 'verifier']) {
        const secret = randomBytes(24).toString('base64url')
        passwords.set(`${cluster}/${role}`, secret)
        const verifier = await ok(['secrets', 'scram-verifier', '--stdin', '--stdout'], {
          stdin: `${secret}\n`,
          record: 'secrets scram-verifier --stdin --stdout   # the password on stdin',
        })
        statements.push(`ALTER ROLE exponetdb_${role} PASSWORD '${verifier.stdout.trim()}';`)
      }
      await writeFile(join(project, `passwords-${env}.sql`), `${statements.join('\n')}\n`, {
        mode: 0o600,
      })
      await ok(['dev', 'sql', env, '--lab', LAB, '--file', `passwords-${env}.sql`])
      await ok(['cluster', 'credential', 'submit', cluster, 'observer'])
      await ok(['cluster', 'confirm', cluster, '--apply'])
      for (const role of ['migrator', 'reader', 'verifier']) {
        await ok(['cluster', 'credential', 'submit', cluster, role])
      }
      const creds = data(await ok(['cluster', 'credentials', cluster, '--json'])).items as {
        state: string
      }[]
      expect(creds.filter((c) => c.state === 'active')).toHaveLength(4)
      await ok(['cluster', 'database', 'register', cluster, 'app', '--apply'])
      ids.databases[env] = data(await ok(['cluster', 'databases', cluster, '--json'])).items.find(
        (d: { name: string }) => d.name === 'app',
      ).id
      // The per-database grants of the server's script, now that the database is registered.
      const script = (await ok(['cluster', 'bootstrap-sql', cluster])).stdout
      const grants = script.slice(script.indexOf('-- database app'))
      expect(grants).toContain('GRANT CONNECT ON DATABASE')
      await ok(['dev', 'sql', env, '--lab', LAB, '--db', 'postgres'], {
        stdin: grants,
        record: `dev sql ${env} --lab ${LAB}   # the "-- database app" part of cluster bootstrap-sql`,
      })
    })
  }

  it('maps the execution role and registers both targets (production through an approval)', async () => {
    await ok([
      'project',
      'update',
      ids.project,
      '--execution-role',
      'migrator=app_migrator',
      '--apply',
    ])
    await ok([
      'target',
      'register',
      '--project',
      ids.project,
      '--environment',
      ids.staging,
      '--database',
      ids.databases.staging,
      '--apply',
    ])
    await ok([
      'target',
      'register',
      '--project',
      ids.project,
      '--environment',
      ids.production,
      '--database',
      ids.databases.production,
      '--apply',
      '--yes',
    ])
    const targets = data(await ok(['target', 'list', '--json'])).items.map(
      (t: { path: string }) => t.path,
    )
    expect(targets.sort()).toEqual(['shop/platform/production', 'shop/platform/staging'])
  })

  let migration = ''
  it('authors a migration locally: init, new, lint, checksum, graph', async () => {
    await ok(['init', '--project', 'shop/platform'])
    const created = data(await ok(['migration', 'new', 'add-notes', '--json']))
    migration = created.migrationId
    await writeFile(
      join(created.path, 'up.sql'),
      'CREATE TABLE public.notes (\n  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n  body text NOT NULL\n);\nGRANT SELECT, INSERT ON public.notes TO app_user;\n',
    )
    await writeFile(
      join(created.path, 'verify.sql'),
      '-- check: the notes table is readable\nSELECT count(*) >= 0 AS ok FROM public.notes;\n',
    )
    await ok(['migration', 'lint'])
    await ok(['migration', 'checksum'])
    await ok(['migration', 'graph'])
  })

  it('plans and applies on staging, verified', async () => {
    const plan = data(
      await ok(['migration', 'plan', '--target', 'shop/platform/staging', '--json']),
    )
    await ok(['plan', 'show', plan.id])
    const applied = await ok(['plan', 'apply', plan.id, '--wait', '--json'], {
      record: 'plan apply <plan> --wait --json',
    })
    expect(data(applied)).toMatchObject({
      state: 'succeeded',
      applyOutcome: 'applied',
      verificationOutcome: 'passed',
    })
    const status = data(
      await ok(['migration', 'status', '--target', 'shop/platform/staging', '--json']),
    )
    expect(JSON.stringify(status)).toContain(migration)
  })

  it('plans the same stored bundle on production with the staging evidence, and applies it after the human steps', async () => {
    // The evidence production binds: the run on the evidence environment that passed.
    const evidence = data(
      await ok(['migration', 'evidence', migration, '--target', 'shop/platform/staging', '--json']),
    )
    expect(evidence.state).toBe('applied')
    expect(evidence.verifications.map((v: { status: string }) => v.status)).toContain('passed')
    const plan = data(
      await ok([
        'migration',
        'plan',
        migration,
        '--target',
        'shop/platform/production',
        '--stored',
        '--json',
      ]),
    )
    await ok(['plan', 'show', plan.id])
    const applied = await ok(['plan', 'apply', plan.id, '--wait', '--yes', '--json'], {
      record: 'plan apply <plan> --wait --yes --json',
    })
    expect(data(applied)).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
    const operation = data(applied).id
    await ok(['operation', 'show', operation])
    const status = data(
      await ok(['migration', 'status', '--target', 'shop/platform/production', '--json']),
    )
    expect(JSON.stringify(status)).toContain(migration)
    // Each applied migration is audited (staging and production), with its checksum.
    const audit = data(await ok(['audit', 'list', '--action', 'migration.apply', '--json']))
    expect(audit.items.length).toBeGreaterThanOrEqual(2)
  })

  it('shows a lint refusal and out-of-band drift for what they are', async () => {
    const created = data(await ok(['migration', 'new', 'drop-notes', '--json']))
    await writeFile(join(created.path, 'up.sql'), 'DROP TABLE public.notes;\n')
    const lint = await exdb(['migration', 'lint', '--json'])
    expect(lint.code).toBe(1)
    await rm(created.path, { recursive: true, force: true })
    // The verified migration is the expected schema: nothing has drifted yet.
    const clean = data(await ok(['drift', 'check', 'shop/platform/staging', '--json']))
    expect([clean.status, clean.counts.drifted]).toEqual(['clean', 0])
    await ok(['dev', 'sql', 'staging', '--lab', LAB, '--db', 'app'], {
      stdin: 'ALTER TABLE public.notes ADD COLUMN out_of_band text;\n',
      record: `dev sql staging --lab ${LAB} --db app   # ALTER TABLE public.notes ADD COLUMN out_of_band text;`,
    })
    const drift = await exdb(['drift', 'check', 'shop/platform/staging', '--json'])
    expect(drift.stdout).toContain('out_of_band')
    // Only the change made outside a migration.
    expect(data(drift)).toMatchObject({ status: 'drifted', counts: { drifted: 1 } })
  })
})
