import { randomBytes } from 'node:crypto'
import { isScope, scopeDefinition } from '@exponetdb/contracts'
import { newId } from '@exponetdb/kernel'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ControlStoreRole, loadBundleSet, migrateControlStore } from '../src/index.ts'
import {
  createTestDatabase,
  type MigratedTestDatabase,
  migratedTestDatabase,
} from '../src/testing/index.ts'
import { bundleDir } from './fixtures.ts'

/**
 * The Wave 3B schema (`oauth`) against PostgreSQL 17: what the database
 * refuses whatever a process sends (G3B items 15, 16, 21, 27). Grants are
 * exercised, never read.
 */
let db: MigratedTestDatabase

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_oauth')
})

afterAll(async () => {
  await db?.drop()
})

type Client = pg.Client

async function as<T>(role: ControlStoreRole | 'super', fn: (c: Client) => Promise<T>): Promise<T> {
  return role === 'super' ? db.asSuperuser(fn) : db.asRole(role, fn)
}

/** The SQLSTATE of running `sql` as `role`, or undefined when it succeeds. */
async function refused(
  role: ControlStoreRole | 'super',
  sql: string,
  params: unknown[] = [],
): Promise<string | undefined> {
  return as(role, async (c) => {
    try {
      await c.query(sql, params)
      return undefined
    } catch (error) {
      const code: unknown =
        typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
      return typeof code === 'string' ? code : 'unknown'
    }
  })
}

const now = () => Date.now()
const hash = () => `sha256:${randomBytes(32).toString('hex')}`
const serve = <T>(fn: (c: Client) => Promise<T>) => as('exdb_serve', fn)
const CLI_CLIENT = 'cli_01M47XTGSDXW4ASYC2ZX7YK0X0'
const WEB_CLIENT = 'cli_01M47XTGSBD4SV7Q3AWZRWY8QP'

async function human(): Promise<string> {
  const id = newId('idn', now())
  const email = `p-${randomBytes(4).toString('hex')}@example.test`
  await serve(async (c) => {
    await c.query(
      `INSERT INTO auth.identities (identity_id, kind, state, email, email_normalized, webauthn_user_handle)
       VALUES ($1, 'human', 'invited', $2, lower($2), $3)`,
      [id, email, randomBytes(32)],
    )
    await c.query(`UPDATE auth.identities SET state = 'active' WHERE identity_id = $1`, [id])
  })
  return id
}

async function serviceAccount(responsible: string): Promise<string> {
  const id = newId('idn', now())
  await serve(async (c) => {
    await c.query(
      `INSERT INTO auth.identities (identity_id, kind, state, display_name) VALUES ($1, 'service', 'invited', 'ci')`,
      [id],
    )
    await c.query(`UPDATE auth.identities SET state = 'active' WHERE identity_id = $1`, [id])
    await c.query(
      `INSERT INTO oauth.service_accounts (identity_id, responsible_identity_id, created_by_identity_id, created_at)
       VALUES ($1, $2, $2, clock_timestamp())`,
      [id, responsible],
    )
  })
  return id
}

async function reauth(identityId: string, ageMinutes = 0): Promise<string> {
  const id = newId('rau', now())
  await serve((c) =>
    c.query(
      `INSERT INTO auth.reauth_events (reauth_event_id, identity_id, session_id, method, factor_id, user_verified)
       VALUES ($1, $2, NULL, 'totp', $3, true)`,
      [id, identityId, newId('fac', now())],
    ),
  )
  if (ageMinutes > 0) {
    await as('super', async (c) => {
      await c.query('BEGIN')
      await c.query('SET LOCAL session_replication_role = replica')
      await c.query(
        `UPDATE auth.reauth_events SET occurred_at = occurred_at - make_interval(mins => $2) WHERE reauth_event_id = $1`,
        [id, ageMinutes],
      )
      await c.query('COMMIT')
    })
  }
  return id
}

const FP = `sha256:${'a'.repeat(64)}`
const FP2 = `sha256:${'b'.repeat(64)}`

async function cimdClient(): Promise<string> {
  const id = newId('cli', now())
  await serve((c) =>
    c.query(
      `INSERT INTO oauth.clients (client_id, external_id, registration, kind, state, display_name, redirect_uris,
                                  token_endpoint_auth_method, grant_types, metadata_fingerprint, metadata_fetched_at,
                                  created_at, state_changed_at)
       VALUES ($1, $2, 'cimd', 'mcp', 'pending', 'Example MCP', ARRAY['http://127.0.0.1/callback'], 'none',
               ARRAY['authorization_code', 'refresh_token'], $3, clock_timestamp(), clock_timestamp(), clock_timestamp())`,
      [id, `https://client.example.test/${id}.json`, FP],
    ),
  )
  return id
}

async function approve(clientId: string, approver: string, fingerprint = FP): Promise<void> {
  await serve((c) =>
    c.query(
      `UPDATE oauth.clients SET state = 'active', approved_fingerprint = $2, approved_by_identity_id = $3
        WHERE client_id = $1`,
      [clientId, fingerprint, approver],
    ),
  )
}

interface GrantInput {
  readonly identityId: string
  readonly clientId: string
  readonly scopes: readonly string[]
  readonly tiers?: readonly string[]
  readonly resource?: 'api' | 'mcp'
  readonly days?: number
  readonly kind?: 'delegated' | 'machine'
  readonly createdBy?: string
  readonly reauthEventId?: string | null
}

function grantSql(input: GrantInput): [string, unknown[], string] {
  const id = newId('grt', now())
  return [
    `INSERT INTO oauth.grants (grant_id, kind, identity_id, client_id, client_kind, resource, scopes, tiers,
                               created_by_identity_id, reauth_event_id, created_at, consent_at, expires_at, state)
     VALUES ($1, $2, $3, $4, 'mcp',
             -- By default the client kind's own resource: /mcp for an MCP client, /api otherwise.
             coalesce($5, (SELECT CASE c.kind WHEN 'mcp' THEN 'mcp' ELSE 'api' END
                             FROM oauth.clients c WHERE c.client_id = $4)),
             $6, $7, $8, $9, clock_timestamp(), clock_timestamp(),
             clock_timestamp() + make_interval(days => $10), 'active')`,
    [
      id,
      input.kind ?? 'delegated',
      input.identityId,
      input.clientId,
      input.resource ?? null,
      input.scopes,
      input.tiers ?? ['nonprod'],
      input.createdBy ?? input.identityId,
      input.reauthEventId ?? null,
      input.days ?? 30,
    ],
    id,
  ]
}

async function grant(input: GrantInput): Promise<string> {
  const [sql, params, id] = grantSql(input)
  await serve((c) => c.query(sql, params))
  return id
}

async function token(
  grantId: string,
  kind: 'access' | 'refresh',
  extra: { clientId: string; identityId: string; scopes: readonly string[] },
) {
  const tokenHash = hash()
  await serve((c) =>
    c.query(
      `INSERT INTO oauth.tokens (kind, token_hash, grant_id, client_id, identity_id, resource, scopes, issued_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, (SELECT g.resource FROM oauth.grants g WHERE g.grant_id = $3), $6,
               clock_timestamp(), clock_timestamp() + interval '1 minute')`,
      [kind, tokenHash, grantId, extra.clientId, extra.identityId, extra.scopes],
    ),
  )
  return tokenHash
}

describe('upgrade from the accepted G3A schema', () => {
  it('applies the Wave 3B bundle on top of the nine G3A bundles, verifies all, then is a no-op', async () => {
    const fresh = await createTestDatabase('exdb_it_oauth_upgrade')
    const g3a = await bundleDir()
    try {
      await g3a.keepOnly([
        '01M46KHY8',
        '01M46KHZ7',
        '01M46KJ06',
        '01M46KJ15',
        '01M46KJ25',
        '01M46KJ34',
        '01M46VP9A',
      ])
      const store = fresh.store('exdb_migrate', { poolMax: 2 })
      const before = await migrateControlStore({
        store,
        bundles: await loadBundleSet(g3a.path),
        engineVersion: 'g3a',
        newInstallationId: () => newId('ins', now()),
      })
      expect(before.applied).toHaveLength(9)
      const after = await migrateControlStore({
        store,
        bundles: await loadBundleSet(),
        engineVersion: 'wave-3b',
        newInstallationId: () => newId('ins', now()),
      })
      expect(after.installationId).toBe(before.installationId)
      expect(after.applied).toEqual(['01M47XQ56MW0JQX3J715X2GDB8'])
      expect(after.verifications.every((v) => v.status === 'passed')).toBe(true)
      expect(after.state.status).toBe('current')
      const again = await migrateControlStore({
        store,
        bundles: await loadBundleSet(),
        engineVersion: 'wave-3b',
        newInstallationId: () => newId('ins', now()),
      })
      expect(again.applied).toEqual([])
    } finally {
      await g3a.remove()
      await fresh.drop()
    }
  })
})

describe('scopes and grants (the database refuses what no grant may hold)', () => {
  it('never stores an MCP-ineligible, session-only, unknown, wildcard or repeated scope for an mcp client', async () => {
    const owner = await human()
    const client = await cimdClient()
    await approve(client, owner)
    for (const scopes of [
      ['access.manage'],
      ['plans.approve'],
      ['api'],
      ['breakglass.activate'],
      ['targets.*'],
      ['*'],
      ['targets.read', 'targets.read'],
      ['targets.read', 'no.such'],
      [],
    ]) {
      const [sql, params] = grantSql({ identityId: owner, clientId: client, scopes })
      expect(await refused('exdb_serve', sql, params), scopes.join(' ')).toBe('EXO03')
    }
    await grant({ identityId: owner, clientId: client, scopes: ['targets.read', 'schema.read'] })
  })

  it('refuses a tiered scope outside the tier restriction, and a lifetime beyond 90 days', async () => {
    const owner = await human()
    const client = await cimdClient()
    await approve(client, owner)
    const [prodInNonprod, p1] = grantSql({
      identityId: owner,
      clientId: client,
      scopes: ['data.read:prod'],
      tiers: ['nonprod'],
    })
    expect(await refused('exdb_serve', prodInNonprod, p1)).toBe('EXO03')
    const [long, p2] = grantSql({
      identityId: owner,
      clientId: client,
      scopes: ['targets.read'],
      days: 91,
    })
    expect(await refused('exdb_serve', long, p2)).toBe('EXO03')
  })

  it('binds an MCP client to /mcp and every other client to /api (G3B final hardening)', async () => {
    const owner = await human()
    const client = await cimdClient()
    await approve(client, owner)
    const [mcpForApi, p1] = grantSql({
      identityId: owner,
      clientId: client,
      scopes: ['targets.read'],
      resource: 'api',
    })
    expect(await refused('exdb_serve', mcpForApi, p1)).toBe('23514')
    const [cliForMcp, p2] = grantSql({
      identityId: owner,
      clientId: CLI_CLIENT,
      scopes: ['targets.read'],
      resource: 'mcp',
    })
    expect(await refused('exdb_serve', cliForMcp, p2)).toBe('23514')
    const g = await grant({ identityId: owner, clientId: client, scopes: ['targets.read'] })
    // A token always carries its grant's resource; an MCP grant never yields an /api token.
    const tokenFor = (resource: string) =>
      refused(
        'exdb_serve',
        `INSERT INTO oauth.tokens (kind, token_hash, grant_id, client_id, identity_id, resource, scopes, issued_at, expires_at)
         VALUES ('access', $1, $2, $3, $4, $5, ARRAY['targets.read'], now(), now())`,
        [hash(), g, client, owner, resource],
      )
    expect(await tokenFor('api')).toBe('EXO06')
    expect(await tokenFor('mcp')).toBeUndefined()
  })

  it('states explicit consent for every production and human-only scope, as the contract does', async () => {
    const rows = await serve(
      async (c) =>
        (
          await c.query(
            `SELECT scope, explicit_consent, tier, human_only FROM oauth.scopes ORDER BY scope COLLATE "C"`,
          )
        ).rows,
    )
    for (const row of rows) {
      const scope: unknown = row.scope
      if (typeof scope !== 'string' || !isScope(scope)) {
        throw new Error(`unknown scope ${String(scope)}`)
      }
      expect(row.explicit_consent, scope).toBe(scopeDefinition(scope).explicitConsent)
      if (row.tier === 'prod' || row.human_only) {
        expect(row.explicit_consent, scope).toBe(true)
      }
    }
    expect(rows.filter((r) => r.explicit_consent)).toHaveLength(15)
    expect(
      await refused(
        'exdb_migrate',
        `UPDATE oauth.scopes SET explicit_consent = false WHERE scope = 'registry.manage'`,
        [],
      ),
    ).toBeDefined()
  })

  it('needs a re-authentication at most 5 minutes old for a production write scope', async () => {
    const owner = await human()
    const client = await cimdClient()
    await approve(client, owner)
    const input = {
      identityId: owner,
      clientId: client,
      scopes: ['migrations.apply:prod'],
      tiers: ['prod'],
    }
    const [none, p1] = grantSql(input)
    expect(await refused('exdb_serve', none, p1)).toBe('EXO03')
    const old = await reauth(owner, 6)
    const [stale, p2] = grantSql({ ...input, reauthEventId: old })
    expect(await refused('exdb_serve', stale, p2)).toBe('EXO03')
    const someoneElse = await reauth(await human())
    const [foreign, p3] = grantSql({ ...input, reauthEventId: someoneElse })
    expect(await refused('exdb_serve', foreign, p3)).toBe('EXO03')
    await grant({ ...input, reauthEventId: await reauth(owner) })
    // A production read needs no re-authentication.
    await grant({ ...input, scopes: ['data.read:prod'] })
  })

  it('gives grants only to active clients and identities; a pending client gets none', async () => {
    const owner = await human()
    const pending = await cimdClient()
    const [sql, params] = grantSql({
      identityId: owner,
      clientId: pending,
      scopes: ['targets.read'],
    })
    expect(await refused('exdb_serve', sql, params)).toBe('EXO03')
    const [web, p2] = grantSql({
      identityId: owner,
      clientId: WEB_CLIENT,
      scopes: ['targets.read'],
    })
    expect(await refused('exdb_serve', web, p2)).toBe('EXO03')
    const other = await human()
    await serve((c) =>
      c.query(`UPDATE auth.identities SET state = 'disabled' WHERE identity_id = $1`, [other]),
    )
    const [disabled, p3] = grantSql({
      identityId: other,
      clientId: CLI_CLIENT,
      scopes: ['targets.read'],
    })
    expect(await refused('exdb_serve', disabled, p3)).toBe('EXO03')
  })

  it('never lets a service identity consent, and never gives a person a machine grant', async () => {
    const owner = await human()
    const svc = await serviceAccount(owner)
    const [sql, params] = grantSql({
      identityId: svc,
      clientId: CLI_CLIENT,
      scopes: ['targets.read'],
    })
    expect(await refused('exdb_serve', sql, params)).toBe('EXO03')
    const [machine, p2] = grantSql({
      identityId: owner,
      clientId: CLI_CLIENT,
      scopes: ['targets.read'],
      kind: 'machine',
    })
    expect(await refused('exdb_serve', machine, p2)).toBe('EXO03')
  })

  it('revokes a grant once and never changes its authority', async () => {
    const owner = await human()
    const id = await grant({ identityId: owner, clientId: CLI_CLIENT, scopes: ['targets.read'] })
    expect(
      await refused(
        'exdb_serve',
        `UPDATE oauth.grants SET scopes = ARRAY['audit.read'] WHERE grant_id = $1`,
        [id],
      ),
    ).toBe('42501')
    await serve((c) =>
      c.query(
        `UPDATE oauth.grants SET state = 'revoked', revoke_reason = 'owner' WHERE grant_id = $1`,
        [id],
      ),
    )
    expect(
      await refused(
        'exdb_serve',
        `UPDATE oauth.grants SET state = 'active', revoke_reason = NULL WHERE grant_id = $1`,
        [id],
      ),
    ).toBe('EXO03')
  })
})

describe('clients (approval binds the exact metadata)', () => {
  it('starts every CIMD and DCR client pending; only the bundles create first-party clients', async () => {
    const id = newId('cli', now())
    expect(
      await refused(
        'exdb_serve',
        `INSERT INTO oauth.clients (client_id, external_id, registration, kind, state, display_name, redirect_uris,
                                    token_endpoint_auth_method, grant_types, metadata_fingerprint, approved_fingerprint,
                                    metadata_fetched_at, created_at, state_changed_at)
         VALUES ($1, 'https://evil.example.test/c.json', 'cimd', 'mcp', 'active', 'x', ARRAY['https://evil.example.test/cb'],
                 'none', ARRAY['authorization_code'], $2, $2, clock_timestamp(), clock_timestamp(), clock_timestamp())`,
        [id, FP],
      ),
    ).toBe('EXO01')
    expect(
      await refused(
        'exdb_serve',
        `INSERT INTO oauth.clients (client_id, external_id, registration, kind, state, display_name, token_endpoint_auth_method,
                                    grant_types, metadata_fingerprint, approved_fingerprint, created_at, state_changed_at)
         VALUES ($1, 'exponetdb-fake', 'first_party', 'cli', 'active', 'ExponetDB CLI', 'none', '{}', $2, $2,
                 clock_timestamp(), clock_timestamp())`,
        [id, FP],
      ),
    ).toBe('EXO01')
  })

  it('refuses a DCR or CIMD client claiming another kind, a secret method or no redirect URI', async () => {
    for (const [kind, method, uris] of [
      ['web', 'none', ['https://a.example.test/cb']],
      ['cli', 'none', ['https://a.example.test/cb']],
      ['mcp', 'private_key_jwt', ['https://a.example.test/cb']],
      ['mcp', 'client_secret_basic', ['https://a.example.test/cb']],
      ['mcp', 'none', []],
      ['mcp', 'none', ['javascript:alert(1)']],
      ['mcp', 'none', ['http://evil.example.test/cb']],
      ['mcp', 'none', ['https://a.example.test/cb#frag']],
    ] as const) {
      const code = await refused(
        'exdb_serve',
        `INSERT INTO oauth.clients (client_id, external_id, registration, kind, state, display_name, redirect_uris,
                                    token_endpoint_auth_method, grant_types, metadata_fingerprint, created_at, state_changed_at)
         VALUES ($1, $2, 'dcr', $3, 'pending', 'x', $4, $5, ARRAY['authorization_code'], $6,
                 clock_timestamp(), clock_timestamp())`,
        [
          newId('cli', now()),
          `exdb-dcr-${randomBytes(32).toString('base64url')}`,
          kind,
          uris,
          method,
          FP,
        ],
      )
      expect(code, `${kind} ${method} ${uris.join(' ')}`).toBe('23514')
    }
  })

  it('keeps an active client only while its metadata fingerprint is the approved one', async () => {
    const owner = await human()
    const client = await cimdClient()
    expect(
      await refused(
        'exdb_serve',
        `UPDATE oauth.clients SET state = 'active' WHERE client_id = $1`,
        [client],
      ),
    ).toBe('EXO01')
    await approve(client, owner)
    // A changed fingerprint cannot stay active; it returns to review and the grant ends.
    const g = await grant({ identityId: owner, clientId: client, scopes: ['targets.read'] })
    expect(
      await refused(
        'exdb_serve',
        `UPDATE oauth.clients SET metadata_fingerprint = $2 WHERE client_id = $1`,
        [client, FP2],
      ),
    ).toBe('23514')
    expect(
      await refused(
        'exdb_serve',
        `UPDATE oauth.clients SET state = 'pending' WHERE client_id = $1`,
        [client],
      ),
    ).toBe('EXO01')
    await serve((c) =>
      c.query(
        `UPDATE oauth.clients SET state = 'pending', metadata_fingerprint = $2 WHERE client_id = $1`,
        [client, FP2],
      ),
    )
    const state = await serve(
      async (c) =>
        (await c.query('SELECT state, revoke_reason FROM oauth.grants WHERE grant_id = $1', [g]))
          .rows[0],
    )
    expect(state).toEqual({ state: 'revoked', revoke_reason: 'client_review' })
    // Re-approval binds the new fingerprint; approving the old one is refused.
    expect(
      await refused(
        'exdb_serve',
        `UPDATE oauth.clients SET state = 'active', approved_fingerprint = $2, approved_by_identity_id = $3 WHERE client_id = $1`,
        [client, FP, owner],
      ),
    ).toBe('EXO01')
    await approve(client, owner, FP2)
  })

  it('never changes security metadata under the same fingerprint, and keeps first-party clients fixed', async () => {
    const owner = await human()
    const client = await cimdClient()
    await approve(client, owner)
    for (const change of [
      `redirect_uris = ARRAY['https://evil.example.test/callback']`,
      `grant_types = ARRAY['authorization_code']`,
      `application_type = 'web'`,
    ]) {
      expect(
        await refused('exdb_serve', `UPDATE oauth.clients SET ${change} WHERE client_id = $1`, [
          client,
        ]),
        change,
      ).toBe('EXO01')
    }
    // Display data may change under the same fingerprint.
    await serve((c) =>
      c.query(`UPDATE oauth.clients SET display_name = 'Renamed MCP' WHERE client_id = $1`, [
        client,
      ]),
    )
    // A first-party client changes only through a bundle; disabling it stays possible.
    for (const change of [
      `redirect_uris = ARRAY['http://127.0.0.1/callback', 'https://evil.example.test/callback'], metadata_fingerprint = '${FP2}', approved_fingerprint = '${FP2}'`,
      `display_name = 'ExponetDB CLI (new)'`,
      `grant_types = ARRAY['authorization_code']`,
    ]) {
      expect(
        await refused('exdb_serve', `UPDATE oauth.clients SET ${change} WHERE client_id = $1`, [
          CLI_CLIENT,
        ]),
        change,
      ).toBe('EXO01')
    }
  })

  it('a disabled client ends its grants and tokens at once', async () => {
    const owner = await human()
    const client = await cimdClient()
    await approve(client, owner)
    const g = await grant({ identityId: owner, clientId: client, scopes: ['targets.read'] })
    const t = await token(g, 'access', {
      clientId: client,
      identityId: owner,
      scopes: ['targets.read'],
    })
    await serve((c) =>
      c.query(`UPDATE oauth.clients SET state = 'disabled' WHERE client_id = $1`, [client]),
    )
    const rows = await serve(async (c) => ({
      grant: (await c.query('SELECT state FROM oauth.grants WHERE grant_id = $1', [g])).rows[0],
      token: (
        await c.query(
          'SELECT revoked_at IS NOT NULL AS revoked FROM oauth.tokens WHERE token_hash = $1',
          [t],
        )
      ).rows[0],
    }))
    expect(rows).toEqual({ grant: { state: 'revoked' }, token: { revoked: true } })
  })

  it('serializes concurrent approve and reject: one final state', async () => {
    const owner = await human()
    const client = await cimdClient()
    const results = await Promise.allSettled([
      approve(client, owner),
      serve((c) =>
        c.query(
          `UPDATE oauth.clients SET state = 'rejected' WHERE client_id = $1 AND state = 'pending'`,
          [client],
        ),
      ),
    ])
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true)
    const state = await serve(
      async (c) =>
        (await c.query('SELECT state FROM oauth.clients WHERE client_id = $1', [client])).rows[0]
          ?.state,
    )
    expect(['active', 'rejected']).toContain(state)
  })
})

describe('codes and tokens (single use, one live refresh token)', () => {
  it('consumes an authorization code once and bounds it to 60 seconds of the database clock', async () => {
    const owner = await human()
    const g = await grant({ identityId: owner, clientId: CLI_CLIENT, scopes: ['targets.read'] })
    const code = hash()
    await serve((c) =>
      c.query(
        `INSERT INTO oauth.authorization_codes (code_hash, grant_id, client_id, identity_id, redirect_uri, code_challenge,
                                                resource, scopes, created_at, expires_at)
         VALUES ($1, $2, $3, $4, 'http://127.0.0.1:5555/callback', $5, 'api', ARRAY['targets.read'],
                 '2000-01-01', '2000-01-01')`,
        [code, g, CLI_CLIENT, owner, 'c'.repeat(43)],
      ),
    )
    const life = await serve(
      async (c) =>
        (
          await c.query(
            `SELECT extract(epoch FROM expires_at - created_at)::int AS seconds,
                  created_at > clock_timestamp() - interval '1 minute' AS fresh
             FROM oauth.authorization_codes WHERE code_hash = $1`,
            [code],
          )
        ).rows[0],
    )
    expect(life).toEqual({ seconds: 60, fresh: true })
    await serve((c) =>
      c.query(
        'UPDATE oauth.authorization_codes SET consumed_at = clock_timestamp() WHERE code_hash = $1',
        [code],
      ),
    )
    expect(
      await refused(
        'exdb_serve',
        'UPDATE oauth.authorization_codes SET consumed_at = clock_timestamp() WHERE code_hash = $1',
        [code],
      ),
    ).toBe('EXO05')
  })

  it('allows one live refresh token per grant and none for a machine grant', async () => {
    const owner = await human()
    const g = await grant({ identityId: owner, clientId: CLI_CLIENT, scopes: ['targets.read'] })
    const ctx = { clientId: CLI_CLIENT, identityId: owner, scopes: ['targets.read'] }
    const r1 = await token(g, 'refresh', ctx)
    await expect(token(g, 'refresh', ctx)).rejects.toMatchObject({ code: '23505' })
    await serve((c) =>
      c.query('UPDATE oauth.tokens SET spent_at = clock_timestamp() WHERE token_hash = $1', [r1]),
    )
    await token(g, 'refresh', ctx)
    expect(
      await refused('exdb_serve', 'UPDATE oauth.tokens SET spent_at = NULL WHERE token_hash = $1', [
        r1,
      ]),
    ).toBe('EXO06')
    expect(
      await refused('exdb_serve', `UPDATE oauth.tokens SET token_hash = $2 WHERE token_hash = $1`, [
        r1,
        hash(),
      ]),
    ).toBe('42501')
  })

  it('issues no token from a revoked grant and wider than the grant; revocation ends every token', async () => {
    const owner = await human()
    const g = await grant({ identityId: owner, clientId: CLI_CLIENT, scopes: ['targets.read'] })
    await expect(
      token(g, 'access', { clientId: CLI_CLIENT, identityId: owner, scopes: ['audit.read'] }),
    ).rejects.toMatchObject({ code: 'EXO06' })
    const a = await token(g, 'access', {
      clientId: CLI_CLIENT,
      identityId: owner,
      scopes: ['targets.read'],
    })
    const life = await serve(
      async (c) =>
        (
          await c.query(
            `SELECT extract(epoch FROM expires_at - issued_at)::int AS seconds FROM oauth.tokens WHERE token_hash = $1`,
            [a],
          )
        ).rows[0],
    )
    expect(life).toEqual({ seconds: 600 })
    await serve((c) =>
      c.query(
        `UPDATE oauth.grants SET state = 'revoked', revoke_reason = 'owner' WHERE grant_id = $1`,
        [g],
      ),
    )
    await expect(
      token(g, 'access', { clientId: CLI_CLIENT, identityId: owner, scopes: ['targets.read'] }),
    ).rejects.toMatchObject({ code: 'EXO06' })
    const revoked = await serve(
      async (c) =>
        (
          await c.query(
            'SELECT revoked_at IS NOT NULL AS revoked FROM oauth.tokens WHERE token_hash = $1',
            [a],
          )
        ).rows[0],
    )
    expect(revoked).toEqual({ revoked: true })
  })

  it('accepts an assertion id once per client', async () => {
    const jti = hash()
    const insert = `INSERT INTO oauth.client_assertions (client_id, jti_hash, expires_at)
                    VALUES ($1, $2, clock_timestamp() + interval '2 minutes')`
    await serve((c) => c.query(insert, [CLI_CLIENT, jti]))
    expect(await refused('exdb_serve', insert, [CLI_CLIENT, jti])).toBe('23505')
    expect(
      await refused(
        'exdb_serve',
        `INSERT INTO oauth.client_assertions (client_id, jti_hash, expires_at) VALUES ($1, $2, clock_timestamp() + interval '1 hour')`,
        [CLI_CLIENT, hash()],
      ),
    ).toBe('EXO08')
  })
})

describe('service accounts and API keys', () => {
  it('a service identity never has a session, a factor, a link or the owner role', async () => {
    const owner = await human()
    const svc = await serviceAccount(owner)
    expect(
      await refused(
        'exdb_serve',
        `INSERT INTO auth.web_sessions (session_id, identity_id, token_hash, csrf_hash, session_epoch, assurance,
                                        created_at, absolute_expires_at, last_seen_at)
         VALUES ($1, $2, $3, $4, 1, 'full', clock_timestamp(), clock_timestamp(), clock_timestamp())`,
        [newId('ses', now()), svc, hash(), hash()],
      ),
    ).toBe('EXO10')
    expect(
      await refused(
        'exdb_serve',
        `INSERT INTO auth.factors (factor_id, identity_id, kind, state) VALUES ($1, $2, 'recovery_codes', 'active')`,
        [newId('fac', now()), svc],
      ),
    ).toBe('EXO10')
    expect(
      await refused(
        'exdb_serve',
        `INSERT INTO auth.capabilities (capability_id, kind, identity_id, token_hash, created_at, expires_at)
         VALUES ($1, 'recovery', $2, $3, clock_timestamp(), clock_timestamp())`,
        [newId('cap', now()), svc, hash()],
      ),
    ).toBe('EXO10')
    const op = newId('op', now())
    await as('super', (c) =>
      c.query(
        `INSERT INTO operations.operations (operation_id, kind, kind_version, state, apply_outcome, verification_outcome, actor_kind, client_kind)
         VALUES ($1, 'access.role_binding.create', 1, 'queued', 'not_started', 'pending', 'system', 'system')`,
        [op],
      ),
    )
    expect(
      await refused(
        'exdb_worker',
        `INSERT INTO auth.role_bindings (binding_id, identity_id, role_id, scope_kind, scope_id, state, origin, created_by_operation_id)
         VALUES ($1, $2, 'owner', 'global', NULL, 'active', 'operation', $3)`,
        [newId('rlb', now()), svc, op],
      ),
    ).toBe('EXO10')
  })

  it('an API key belongs to a service account, holds ci scopes only, and expires within 365 days', async () => {
    const owner = await human()
    const svc = await serviceAccount(owner)
    const insert = `INSERT INTO oauth.api_keys (key_id, identity_id, key_hash, scopes, tiers, created_by_identity_id,
                                                reauth_event_id, created_at, expires_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp(), clock_timestamp() + make_interval(days => $8))`
    const key = (
      identityId: string,
      scopes: string[],
      days = 90,
      tiers = ['nonprod'],
      rau: string | null = null,
    ) => [newId('key', now()), identityId, hash(), scopes, tiers, owner, rau, days]
    // A person is no service account: the guard refuses before the foreign key would.
    expect(await refused('exdb_serve', insert, key(owner, ['targets.read']))).toBe('EXO09')
    expect(await refused('exdb_serve', insert, key(svc, ['access.manage']))).toBe('EXO09')
    expect(await refused('exdb_serve', insert, key(svc, ['targets.read'], 366))).toBe('EXO09')
    expect(
      await refused('exdb_serve', insert, key(svc, ['migrations.apply:prod'], 30, ['prod'])),
    ).toBe('EXO09')
    expect(
      await refused(
        'exdb_serve',
        insert,
        key(svc, ['migrations.apply:prod'], 30, ['prod'], await reauth(owner)),
      ),
    ).toBeUndefined()
    const values = key(svc, ['targets.read'])
    await serve((c) => c.query(insert, values))
    expect(
      await refused(
        'exdb_serve',
        `UPDATE oauth.api_keys SET expires_at = expires_at + interval '1 day' WHERE key_id = $1`,
        [values[0]],
      ),
    ).toBe('42501')
  })

  it('disabling a service identity revokes its API keys and grants and disables its client', async () => {
    const owner = await human()
    const svc = await serviceAccount(owner)
    const client = newId('cli', now())
    await serve((c) =>
      c.query(
        `INSERT INTO oauth.clients (client_id, external_id, registration, kind, state, display_name,
                                    token_endpoint_auth_method, grant_types, metadata_fingerprint, approved_fingerprint,
                                    approved_by_identity_id, service_identity_id, jwks, created_by_identity_id,
                                    created_at, state_changed_at)
         VALUES ($1, $1, 'pre_registered', 'ci', 'active', 'ci', 'private_key_jwt', ARRAY['client_credentials'], $2, $2,
                 $3, $4, '{"keys":[{"kty":"OKP"}]}', $3, clock_timestamp(), clock_timestamp())`,
        [client, FP, owner, svc],
      ),
    )
    // Keys are swapped only with the new fingerprint approved in the same change.
    expect(
      await refused(
        'exdb_serve',
        `UPDATE oauth.clients SET jwks = '{"keys":[{"kty":"EC"}]}' WHERE client_id = $1`,
        [client],
      ),
    ).toBe('EXO01')
    const g = await grant({
      identityId: svc,
      clientId: client,
      scopes: ['targets.read'],
      kind: 'machine',
      createdBy: owner,
    })
    const keyId = newId('key', now())
    await serve((c) =>
      c.query(
        `INSERT INTO oauth.api_keys (key_id, identity_id, key_hash, scopes, tiers, created_by_identity_id, created_at, expires_at)
         VALUES ($1, $2, $3, ARRAY['targets.read'], ARRAY['nonprod'], $4, clock_timestamp(), clock_timestamp() + interval '30 days')`,
        [keyId, svc, hash(), owner],
      ),
    )
    await serve((c) =>
      c.query(`UPDATE auth.identities SET state = 'disabled' WHERE identity_id = $1`, [svc]),
    )
    const after = await serve(async (c) => ({
      grant: (
        await c.query('SELECT state, revoke_reason FROM oauth.grants WHERE grant_id = $1', [g])
      ).rows[0],
      key: (await c.query('SELECT revoke_reason FROM oauth.api_keys WHERE key_id = $1', [keyId]))
        .rows[0],
      client: (await c.query('SELECT state FROM oauth.clients WHERE client_id = $1', [client]))
        .rows[0],
    }))
    expect(after).toEqual({
      grant: { state: 'revoked', revoke_reason: 'identity_disabled' },
      key: { revoke_reason: 'identity_disabled' },
      client: { state: 'disabled' },
    })
  })

  it('disabling a person revokes their delegated grants', async () => {
    const person = await human()
    const g = await grant({ identityId: person, clientId: CLI_CLIENT, scopes: ['targets.read'] })
    await serve((c) =>
      c.query(`UPDATE auth.identities SET state = 'disabled' WHERE identity_id = $1`, [person]),
    )
    const row = await serve(
      async (c) =>
        (await c.query('SELECT state, revoke_reason FROM oauth.grants WHERE grant_id = $1', [g]))
          .rows[0],
    )
    expect(row).toEqual({ state: 'revoked', revoke_reason: 'identity_disabled' })
  })
})

describe('least privilege on the oauth schema (forbidden actions fail)', () => {
  it('the gateway and audit maintenance see nothing of oauth', async () => {
    for (const role of ['exdb_gateway', 'exdb_audit_maint'] as const) {
      for (const table of ['tokens', 'grants', 'clients', 'api_keys', 'authorization_codes']) {
        expect(await refused(role, `SELECT * FROM oauth.${table}`), `${role} ${table}`).toBe(
          '42501',
        )
      }
    }
  })

  it('the worker reads no hash or key and cannot issue, widen or revoke anything', async () => {
    expect(await refused('exdb_worker', 'SELECT token_hash FROM oauth.tokens')).toBe('42501')
    expect(await refused('exdb_worker', 'SELECT code_hash FROM oauth.authorization_codes')).toBe(
      '42501',
    )
    expect(await refused('exdb_worker', 'SELECT * FROM oauth.api_keys')).toBe('42501')
    expect(await refused('exdb_worker', 'SELECT jwks FROM oauth.clients')).toBe('42501')
    expect(await refused('exdb_worker', 'SELECT user_code_hash FROM oauth.device_codes')).toBe(
      '42501',
    )
    expect(
      await refused('exdb_worker', 'SELECT binding_hash FROM oauth.authorization_requests'),
    ).toBe('42501')
    expect(
      await refused('exdb_worker', `UPDATE oauth.grants SET state = 'revoked' WHERE false`),
    ).toBe('42501')
    expect(
      await refused(
        'exdb_worker',
        `INSERT INTO oauth.tokens (kind, token_hash, grant_id, client_id, identity_id, resource, scopes, issued_at, expires_at)
         VALUES ('access', $1, 'grt_00000000000000000000000000', $2, 'idn_00000000000000000000000000', 'api', '{}', now(), now())`,
        [hash(), CLI_CLIENT],
      ),
    ).toBe('42501')
  })

  it('serve cannot delete history, extend the scope catalog or prune live rows', async () => {
    expect(await refused('exdb_serve', 'DELETE FROM oauth.tokens')).toBe('42501')
    expect(await refused('exdb_serve', 'DELETE FROM oauth.grants')).toBe('42501')
    expect(await refused('exdb_serve', 'DELETE FROM oauth.api_keys')).toBe('42501')
    expect(
      await refused(
        'exdb_serve',
        `INSERT INTO oauth.scopes VALUES ('anything.at_all', 'access.manage', NULL, true, ARRAY['mcp'], false, true)`,
      ),
    ).toBe('42501')
    expect(
      await refused(
        'super',
        `UPDATE oauth.scopes SET mcp_grantable = true WHERE scope = 'access.manage'`,
      ),
    ).toBe('EXA01')
  })

  it('the worker prunes only what has ended', async () => {
    const owner = await human()
    const g = await grant({ identityId: owner, clientId: CLI_CLIENT, scopes: ['targets.read'] })
    await token(g, 'access', { clientId: CLI_CLIENT, identityId: owner, scopes: ['targets.read'] })
    expect(await refused('exdb_worker', 'DELETE FROM oauth.tokens WHERE grant_id = $1', [g])).toBe(
      'EXO06',
    )
  })
})
