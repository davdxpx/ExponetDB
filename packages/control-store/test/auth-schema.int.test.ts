import { randomBytes } from 'node:crypto'
import { newId } from '@exponetdb/kernel'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ControlStoreRole, loadBundleSet, migrateControlStore } from '../src/index.ts'
import {
  createTestDatabase,
  type MigratedTestDatabase,
  migratedTestDatabase,
} from '../src/testing/index.ts'
import { bundleDir } from './fixtures.ts'

/**
 * The Wave 3A schema (auth, access control, approvals) against PostgreSQL
 * 17: what the database itself refuses, whatever a process sends. Grants are
 * exercised, not read.
 */
let db: MigratedTestDatabase

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_auth')
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
const ARGON = `$argon2id$v=19$m=65536,t=3,p=1$${'A'.repeat(22)}$${'B'.repeat(43)}`

async function identity(options: { bootstrap?: boolean; email?: string } = {}): Promise<string> {
  const id = newId('idn', now())
  const email = options.email ?? `p-${randomBytes(4).toString('hex')}@example.test`
  await as('exdb_serve', (c) =>
    c.query(
      `INSERT INTO auth.identities (identity_id, kind, state, email, email_normalized, webauthn_user_handle, bootstrap)
       VALUES ($1, 'human', 'invited', $2, lower($2), $3, $4)`,
      [id, email, randomBytes(32), options.bootstrap ?? false],
    ),
  )
  return id
}

async function activate(identityId: string): Promise<void> {
  await as('exdb_serve', (c) =>
    c.query(`UPDATE auth.identities SET state = 'active' WHERE identity_id = $1`, [identityId]),
  )
}

async function operation(state: 'queued' | 'awaiting_approval' = 'queued', planId?: string) {
  const id = newId('op', now())
  await as('super', (c) =>
    c.query(
      `INSERT INTO operations.operations
         (operation_id, plan_id, kind, kind_version, state, apply_outcome, verification_outcome, actor_kind, client_kind)
       VALUES ($1, $2, 'access.role_binding.create', 1, $3, 'not_started', 'pending', 'system', 'system')`,
      [id, planId ?? null, state],
    ),
  )
  return id
}

async function bind(
  identityId: string,
  role: string,
  scope: [string, string | null] = ['global', null],
) {
  const id = newId('rlb', now())
  const op = await operation()
  await as('exdb_worker', (c) =>
    c.query(
      `INSERT INTO auth.role_bindings (binding_id, identity_id, role_id, scope_kind, scope_id, state, origin, created_by_operation_id)
       VALUES ($1, $2, $3, $4, $5, 'active', 'operation', $6)`,
      [id, identityId, role, scope[0], scope[1], op],
    ),
  )
  return id
}

async function revokeBinding(c: Client, bindingId: string, op: string): Promise<void> {
  await c.query(
    `UPDATE auth.role_bindings SET state = 'revoked', revoked_at = clock_timestamp(),
            revoke_reason = 'operation', revoked_by_operation_id = $2
      WHERE binding_id = $1`,
    [bindingId, op],
  )
}

async function completeSetupFactors(identityId: string): Promise<void> {
  await as('exdb_serve', async (c) => {
    const passkey = newId('fac', now())
    await c.query(
      `INSERT INTO auth.factors (factor_id, identity_id, kind, state, label, credential_id, public_key, sign_count, backed_up, device_type)
       VALUES ($1, $2, 'passkey', 'active', 'key', $3, $4, 0, true, 'multiDevice')`,
      [passkey, identityId, randomBytes(32), randomBytes(77)],
    )
    await c.query(
      `INSERT INTO auth.factors (factor_id, identity_id, kind, state, password_hash) VALUES ($1, $2, 'password', 'active', $3)`,
      [newId('fac', now()), identityId, ARGON],
    )
    await c.query(
      `INSERT INTO auth.factors (factor_id, identity_id, kind, state, totp_secret_id, totp_secret_version)
       VALUES ($1, $2, 'totp', 'active', $3, 1)`,
      [newId('fac', now()), identityId, newId('sec', now())],
    )
    const set = newId('fac', now())
    await c.query(
      `INSERT INTO auth.factors (factor_id, identity_id, kind, state) VALUES ($1, $2, 'recovery_codes', 'active')`,
      [set, identityId],
    )
    for (let i = 1; i <= 10; i++) {
      await c.query(
        'INSERT INTO auth.recovery_codes (factor_id, code_index, code_hash) VALUES ($1, $2, $3)',
        [set, i, hash()],
      )
    }
    const cap = newId('cap', now())
    await c.query(
      `INSERT INTO auth.capabilities (capability_id, kind, identity_id, token_hash, created_at, expires_at)
       VALUES ($1, 'setup', $2, $3, clock_timestamp(), clock_timestamp())`,
      [cap, identityId, hash()],
    )
    await c.query(
      'UPDATE auth.capabilities SET redeemed_at = clock_timestamp() WHERE capability_id = $1',
      [cap],
    )
  })
}

describe('upgrade from the G2 schema', () => {
  it('applies the three Wave 3A bundles on top of the six Wave 2 bundles, verifies all, then is a no-op', async () => {
    const fresh = await createTestDatabase('exdb_it_upgrade')
    const dir = await bundleDir()
    try {
      await dir.keepOnly([
        '01M46KHY8',
        '01M46KHZ7',
        '01M46KJ06',
        '01M46KJ15',
        '01M46KJ25',
        '01M46KJ34',
      ])
      const store = fresh.store('exdb_migrate', { poolMax: 2 })
      const g2 = await migrateControlStore({
        store,
        bundles: await loadBundleSet(dir.path),
        engineVersion: 'g2',
        newInstallationId: () => newId('ins', now()),
      })
      expect(g2.state.status).toBe('current')
      expect(g2.applied).toHaveLength(6)
      const wave3a = await migrateControlStore({
        store,
        bundles: await loadBundleSet(),
        engineVersion: 'wave-3a',
        newInstallationId: () => newId('ins', now()),
      })
      expect(wave3a.installationId).toBe(g2.installationId)
      expect(wave3a.applied).toEqual([
        '01M46VP9A1J9EGS4ZYVCFC16NQ',
        '01M46VP9A27KW2NNSGCB14RTEE',
        '01M46VP9A3AH63EHFZB448Y6MA',
      ])
      expect(wave3a.verifications.every((v) => v.status === 'passed')).toBe(true)
      expect(wave3a.state.status).toBe('current')
      const again = await migrateControlStore({
        store,
        bundles: await loadBundleSet(),
        engineVersion: 'wave-3a',
        newInstallationId: () => newId('ins', now()),
      })
      expect(again.applied).toEqual([])
      expect(again.verifications).toEqual([])
    } finally {
      await dir.remove()
      await fresh.drop()
    }
  })
})

describe('least privilege on the auth and approvals schemas (forbidden actions fail)', () => {
  it('the gateway and audit maintenance see nothing of auth, approvals or the auth secrets', async () => {
    for (const role of ['exdb_gateway', 'exdb_audit_maint'] as const) {
      expect(await refused(role, 'SELECT * FROM auth.factors')).toBe('42501')
      expect(await refused(role, 'SELECT * FROM auth.web_sessions')).toBe('42501')
      expect(await refused(role, 'SELECT * FROM auth.identities')).toBe('42501')
      expect(await refused(role, 'SELECT * FROM approvals.plan_approvals')).toBe('42501')
      expect(await refused(role, 'SELECT * FROM secrets.secret_blobs_auth')).toBe('42501')
    }
  })

  it('the worker reads no password hash, token hash, recovery code, address or auth secret', async () => {
    expect(await refused('exdb_worker', 'SELECT password_hash FROM auth.factors')).toBe('42501')
    expect(await refused('exdb_worker', 'SELECT public_key FROM auth.factors')).toBe('42501')
    expect(await refused('exdb_worker', 'SELECT token_hash FROM auth.web_sessions')).toBe('42501')
    expect(await refused('exdb_worker', 'SELECT csrf_hash FROM auth.web_sessions')).toBe('42501')
    expect(await refused('exdb_worker', 'SELECT token_hash FROM auth.capabilities')).toBe('42501')
    expect(await refused('exdb_worker', 'SELECT * FROM auth.recovery_codes')).toBe('42501')
    expect(await refused('exdb_worker', 'SELECT email FROM auth.identities')).toBe('42501')
    expect(await refused('exdb_worker', 'SELECT * FROM auth.installation_keys')).toBe('42501')
    expect(await refused('exdb_worker', 'SELECT * FROM secrets.secret_blobs_auth')).toBe('42501')
  })

  it('serve cannot change role bindings, enable or erase identities, or change the role catalog', async () => {
    const who = await identity()
    expect(
      await refused(
        'exdb_serve',
        `INSERT INTO auth.role_bindings (binding_id, identity_id, role_id, scope_kind, state, origin)
         VALUES ($1, $2, 'owner', 'global', 'active', 'bootstrap')`,
        [newId('rlb', now()), who],
      ),
    ).toBe('42501')
    expect(await refused('exdb_serve', `UPDATE auth.role_bindings SET state = 'revoked'`)).toBe(
      '42501',
    )
    expect(await refused('exdb_serve', 'DELETE FROM auth.role_bindings')).toBe('42501')
    expect(await refused('exdb_serve', 'UPDATE auth.identities SET authz_revision = 99')).toBe(
      '42501',
    )
    expect(await refused('exdb_serve', 'DELETE FROM auth.identities')).toBe('42501')
    expect(
      await refused('exdb_serve', 'UPDATE approvals.plan_approvals SET decision = $1', [
        'approved',
      ]),
    ).toBe('42501')
  })

  it('no runtime login creates tables, changes roles or their permissions, links external subjects or truncates', async () => {
    for (const role of ['exdb_serve', 'exdb_worker', 'exdb_gateway', 'exdb_audit_maint'] as const) {
      expect(await refused(role, 'CREATE TABLE auth.planted (x int)'), role).toBe('42501')
      expect(await refused(role, 'CREATE TABLE approvals.planted (x int)'), role).toBe('42501')
      expect(
        await refused(role, `INSERT INTO auth.role_permissions VALUES ('viewer', 'data.read')`),
        role,
      ).toBe('42501')
      expect(await refused(role, `UPDATE auth.roles SET title = 'x'`), role).toBe('42501')
      expect(await refused(role, 'TRUNCATE auth.role_bindings'), role).toBe('42501')
      expect(
        await refused(
          role,
          `INSERT INTO auth.external_subjects (provider_id, issuer, subject, identity_id)
           VALUES ('local', 'https://idp.example.test', 'x', 'idn_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z')`,
        ),
        role,
      ).toBe('42501')
    }
  })

  it('even the schema owner cannot add a permission outside the catalog, a wildcard, or change a seeded row', async () => {
    expect(
      await refused('exdb_migrate', `INSERT INTO auth.role_permissions VALUES ('viewer', '*')`),
    ).toBe('23514')
    expect(
      await refused(
        'exdb_migrate',
        `INSERT INTO auth.role_permissions VALUES ('viewer', 'targets.destroy')`,
      ),
    ).toBe('23514')
    expect(
      await refused(
        'exdb_migrate',
        `UPDATE auth.role_permissions SET permission = 'access.manage' WHERE role_id = 'viewer'`,
      ),
    ).toBe('EXA01')
    expect(await refused('exdb_migrate', `DELETE FROM auth.roles WHERE role_id = 'owner'`)).toBe(
      'EXA01',
    )
  })
})

describe('identity lifecycle in the database', () => {
  it('serve activates and disables; the worker enables and erases; erased never changes', async () => {
    const who = await identity()
    await activate(who)
    expect(
      await refused(
        'exdb_serve',
        `UPDATE auth.identities SET state = 'disabled' WHERE identity_id = $1`,
        [who],
      ),
    ).toBeUndefined()
    expect(
      await refused(
        'exdb_serve',
        `UPDATE auth.identities SET state = 'active' WHERE identity_id = $1`,
        [who],
      ),
    ).toBe('EXU01')
    expect(
      await refused(
        'exdb_worker',
        `UPDATE auth.identities SET state = 'active' WHERE identity_id = $1`,
        [who],
      ),
    ).toBeUndefined()
    expect(
      await refused(
        'exdb_worker',
        `UPDATE auth.identities SET state = 'disabled' WHERE identity_id = $1`,
        [who],
      ),
    ).toBe('EXU01')
    expect(
      await refused(
        'exdb_worker',
        `UPDATE auth.identities SET state = 'erased', email = NULL, email_normalized = NULL,
                display_name = NULL, webauthn_user_handle = NULL WHERE identity_id = $1`,
        [who],
      ),
    ).toBeUndefined()
    expect(
      await refused(
        'exdb_worker',
        `UPDATE auth.identities SET session_epoch = 9 WHERE identity_id = $1`,
        [who],
      ),
    ).toBe('EXU01')
    expect(
      await refused(
        'exdb_serve',
        `UPDATE auth.identities SET email = 'x@example.test' WHERE identity_id = $1`,
        [who],
      ),
    ).toBe('EXU01')
  })

  it('an identity starts invited, and its e-mail changes only before activation', async () => {
    expect(
      await refused(
        'exdb_serve',
        `INSERT INTO auth.identities (identity_id, kind, state, email, email_normalized, webauthn_user_handle)
         VALUES ($1, 'human', 'active', 'a@example.test', 'a@example.test', $2)`,
        [newId('idn', now()), randomBytes(32)],
      ),
    ).toBe('EXU01')
    const who = await identity()
    expect(
      await refused(
        'exdb_serve',
        `UPDATE auth.identities SET email = 'new@example.test', email_normalized = 'new@example.test' WHERE identity_id = $1`,
        [who],
      ),
    ).toBeUndefined()
    await activate(who)
    expect(
      await refused(
        'exdb_serve',
        `UPDATE auth.identities SET email = 'other@example.test', email_normalized = 'other@example.test' WHERE identity_id = $1`,
        [who],
      ),
    ).toBe('EXU01')
  })
})

describe('one-time links, challenges and sessions', () => {
  it('a link lives exactly 30 minutes or 24 hours from the database clock, is redeemed once, one live link per kind', async () => {
    const who = await identity()
    const issuer = await identity()
    const cap = newId('cap', now())
    const token = hash()
    await as('exdb_serve', (c) =>
      c.query(
        `INSERT INTO auth.capabilities (capability_id, kind, identity_id, token_hash, issued_by_identity_id, created_at, expires_at)
         VALUES ($1, 'invitation', $2, $3, $4, '2000-01-01', '2100-01-01')`,
        [cap, who, token, issuer],
      ),
    )
    const row = await as('exdb_serve', (c) =>
      c.query(
        `SELECT expires_at - created_at = interval '24 hours' AS exact, created_at > now() - interval '1 minute' AS fresh
           FROM auth.capabilities WHERE capability_id = $1`,
        [cap],
      ),
    )
    expect(row.rows[0]).toEqual({ exact: true, fresh: true })
    expect(
      await refused(
        'exdb_serve',
        `INSERT INTO auth.capabilities (capability_id, kind, identity_id, token_hash, issued_by_identity_id, created_at, expires_at)
         VALUES ($1, 'invitation', $2, $3, $4, now(), now())`,
        [newId('cap', now()), who, hash(), issuer],
      ),
    ).toBe('23505')
    const redeem = `UPDATE auth.capabilities SET redeemed_at = clock_timestamp()
                     WHERE token_hash = $1 AND redeemed_at IS NULL AND invalidated_at IS NULL AND expires_at > clock_timestamp()`
    const first = await as('exdb_serve', (c) => c.query(redeem, [token]))
    const second = await as('exdb_serve', (c) => c.query(redeem, [token]))
    expect(first.rowCount).toBe(1)
    expect(second.rowCount).toBe(0)
    expect(
      await refused(
        'exdb_serve',
        'UPDATE auth.capabilities SET invalidated_at = clock_timestamp() WHERE capability_id = $1',
        [cap],
      ),
    ).toBe('EXU03')
  })

  it('an expired link cannot be redeemed, even by a direct update', async () => {
    const who = await identity()
    const cap = newId('cap', now())
    await as('exdb_serve', (c) =>
      c.query(
        `INSERT INTO auth.capabilities (capability_id, kind, identity_id, token_hash, created_at, expires_at)
         VALUES ($1, 'setup', $2, $3, now(), now())`,
        [cap, who, hash()],
      ),
    )
    // Move the link into the past as the superuser (the database clock is not injectable).
    await as('super', async (c) => {
      await c.query('ALTER TABLE auth.capabilities DISABLE TRIGGER capabilities_guard')
      await c.query(
        `UPDATE auth.capabilities SET created_at = created_at - interval '31 minutes',
                expires_at = expires_at - interval '31 minutes' WHERE capability_id = $1`,
        [cap],
      )
      await c.query('ALTER TABLE auth.capabilities ENABLE TRIGGER capabilities_guard')
    })
    expect(
      await refused(
        'exdb_serve',
        'UPDATE auth.capabilities SET redeemed_at = clock_timestamp() WHERE capability_id = $1',
        [cap],
      ),
    ).toBe('EXU03')
  })

  it('a session lives 12 hours from creation, rotates both secrets at once, and a revoked session never changes', async () => {
    const who = await identity()
    await activate(who)
    const ses = newId('ses', now())
    await as('exdb_serve', (c) =>
      c.query(
        `INSERT INTO auth.web_sessions (session_id, identity_id, token_hash, csrf_hash, session_epoch, assurance, created_at, absolute_expires_at, last_seen_at)
         VALUES ($1, $2, $3, $4, 7, 'full', '2000-01-01', '2100-01-01', '2000-01-01')`,
        [ses, who, hash(), hash()],
      ),
    )
    const row = await as('exdb_serve', (c) =>
      c.query(
        `SELECT absolute_expires_at - created_at = interval '12 hours' AS twelve, session_epoch,
                created_at > now() - interval '1 minute' AS fresh FROM auth.web_sessions WHERE session_id = $1`,
        [ses],
      ),
    )
    expect(row.rows[0]).toEqual({ twelve: true, session_epoch: 1, fresh: true })
    expect(
      await refused(
        'exdb_serve',
        'UPDATE auth.web_sessions SET token_hash = $2 WHERE session_id = $1',
        [ses, hash()],
      ),
    ).toBe('EXU05')
    expect(
      await refused(
        'exdb_serve',
        'UPDATE auth.web_sessions SET token_hash = $2, csrf_hash = $3, secret_generation = 2 WHERE session_id = $1',
        [ses, hash(), hash()],
      ),
    ).toBeUndefined()
    expect(
      await refused(
        'exdb_serve',
        `UPDATE auth.web_sessions SET assurance = 'recovery' WHERE session_id = $1`,
        [ses],
      ),
    ).toBe('EXU05')
    expect(
      await refused(
        'exdb_serve',
        `UPDATE auth.web_sessions SET revoked_at = clock_timestamp(), revoke_reason = 'logout' WHERE session_id = $1`,
        [ses],
      ),
    ).toBeUndefined()
    expect(
      await refused(
        'exdb_serve',
        `UPDATE auth.web_sessions SET last_seen_at = now() WHERE session_id = $1`,
        [ses],
      ),
    ).toBe('EXU05')
    expect(
      await refused('exdb_serve', 'DELETE FROM auth.web_sessions WHERE session_id = $1', [ses]),
    ).toBe('42501')
  })

  it('a session is issued to an active identity only; the re-authentication time comes from its event', async () => {
    const invited = await identity()
    expect(
      await refused(
        'exdb_serve',
        `INSERT INTO auth.web_sessions (session_id, identity_id, token_hash, csrf_hash, session_epoch, assurance, created_at, absolute_expires_at, last_seen_at)
         VALUES ($1, $2, $3, $4, 1, 'full', now(), now(), now())`,
        [newId('ses', now()), invited, hash(), hash()],
      ),
    ).toBe('EXU05')
    const who = await identity()
    await activate(who)
    const other = await identity()
    await activate(other)
    const rau = newId('rau', now())
    await as('exdb_serve', (c) =>
      c.query(
        `INSERT INTO auth.reauth_events (reauth_event_id, identity_id, method, factor_id, user_verified, occurred_at)
         VALUES ($1, $2, 'totp', $3, false, '2000-01-01')`,
        [rau, other, newId('fac', now())],
      ),
    )
    // Another identity's proof cannot back this session.
    expect(
      await refused(
        'exdb_serve',
        `INSERT INTO auth.web_sessions (session_id, identity_id, token_hash, csrf_hash, session_epoch, assurance,
                                        created_at, absolute_expires_at, last_seen_at, reauth_event_id, reauth_at)
         VALUES ($1, $2, $3, $4, 1, 'full', now(), now(), now(), $5, '2100-01-01')`,
        [newId('ses', now()), who, hash(), hash(), rau],
      ),
    ).toBe('EXU05')
    expect(
      await refused(
        'exdb_serve',
        `INSERT INTO auth.reauth_events (reauth_event_id, identity_id, method, factor_id, user_verified)
         VALUES ($1, $2, 'passkey', $3, false)`,
        [newId('rau', now()), who, newId('fac', now())],
      ),
    ).toBe('23514')
    expect(await refused('exdb_serve', 'UPDATE auth.reauth_events SET method = $1', ['totp'])).toBe(
      '42501',
    )
  })

  it('a challenge is consumed once; live challenges cannot be deleted', async () => {
    const chl = newId('chl', now())
    await as('exdb_serve', (c) =>
      c.query(
        `INSERT INTO auth.challenges (challenge_id, kind, handle_hash, webauthn_challenge, created_at, expires_at)
         VALUES ($1, 'passkey_login', $2, $3, now(), now())`,
        [chl, hash(), randomBytes(32).toString('base64url')],
      ),
    )
    const consume = `UPDATE auth.challenges SET consumed_at = clock_timestamp()
                      WHERE challenge_id = $1 AND consumed_at IS NULL AND expires_at > clock_timestamp()`
    expect((await as('exdb_serve', (c) => c.query(consume, [chl]))).rowCount).toBe(1)
    expect((await as('exdb_serve', (c) => c.query(consume, [chl]))).rowCount).toBe(0)
    expect(
      await refused('exdb_worker', 'DELETE FROM auth.challenges WHERE challenge_id = $1', [chl]),
    ).toBe('EXU04')
  })
})

describe('first-owner activation and the last-owner invariant', () => {
  it('activates the first owner only when the setup is complete, then refuses forever', async () => {
    const pending = await identity({ bootstrap: true })
    const call = 'SELECT auth.activate_bootstrap_owner($1, $2)'
    expect(await refused('exdb_serve', call, [pending, newId('rlb', now())])).toBe('EXU07')
    expect(await refused('exdb_worker', call, [pending, newId('rlb', now())])).toBe('42501')
    await completeSetupFactors(pending)
    expect(await refused('exdb_serve', call, [pending, newId('rlb', now())])).toBeUndefined()
    const owners = await as('exdb_serve', (c) => c.query('SELECT auth.active_owner_count() AS n'))
    expect(Number(owners.rows[0]?.n)).toBe(1)
    // A second pending bootstrap identity can never become an owner now.
    const late = await identity({ bootstrap: true })
    await completeSetupFactors(late)
    expect(await refused('exdb_serve', call, [late, newId('rlb', now())])).toBe('EXU07')
    // A second bootstrap identity cannot even wait while one is pending.
    expect(
      await refused(
        'exdb_serve',
        `INSERT INTO auth.identities (identity_id, kind, state, email, email_normalized, webauthn_user_handle, bootstrap)
         VALUES ($1, 'human', 'invited', 'b2@example.test', 'b2@example.test', $2, true)`,
        [newId('idn', now()), randomBytes(32)],
      ),
    ).toBe('23505')
  })

  it('refuses to revoke the last owner binding or to disable the last owner', async () => {
    const owners = await as('exdb_serve', (c) =>
      c.query(
        `SELECT b.binding_id, b.identity_id FROM auth.role_bindings b JOIN auth.identities i USING (identity_id)
          WHERE b.role_id = 'owner' AND b.state = 'active' AND i.state = 'active'`,
      ),
    )
    expect(owners.rows).toHaveLength(1)
    const [owner] = owners.rows
    const sole = String(owner?.binding_id)
    const soleIdentity = String(owner?.identity_id)
    const op = await operation()
    const revoke = await as('exdb_worker', async (c) => {
      try {
        await revokeBinding(c, sole, op)
        return undefined
      } catch (error) {
        return Reflect.get(Object(error), 'code')
      }
    })
    expect(revoke).toBe('EXU06')
    expect(
      await refused(
        'exdb_serve',
        `UPDATE auth.identities SET state = 'disabled' WHERE identity_id = $1`,
        [soleIdentity],
      ),
    ).toBe('EXU06')
  })

  it('two concurrent removals of two owners: exactly one succeeds', async () => {
    const second = await identity()
    await activate(second)
    const b2 = await bind(second, 'owner')
    const first = await as('exdb_serve', (c) =>
      c.query(
        `SELECT b.binding_id FROM auth.role_bindings b WHERE b.role_id = 'owner' AND b.state = 'active' AND b.origin = 'bootstrap'`,
      ),
    )
    const b1 = String(first.rows[0]?.binding_id)
    const ops = [await operation(), await operation()]
    const a = new pg.Client({ connectionString: db.url('exdb_worker') })
    const b = new pg.Client({ connectionString: db.url('exdb_worker') })
    await a.connect()
    await b.connect()
    try {
      await a.query('BEGIN')
      await b.query('BEGIN')
      const revokeSql = `UPDATE auth.role_bindings SET state = 'revoked', revoked_at = clock_timestamp(),
                                revoke_reason = 'operation', revoked_by_operation_id = $2 WHERE binding_id = $1`
      await a.query(revokeSql, [b1, ops[0]])
      // b blocks on the owner lock until a commits, then sees a's revocation.
      const pending = b.query(revokeSql, [b2, ops[1]]).then(
        () => 'ok',
        (error: unknown) => String(Reflect.get(Object(error), 'code')),
      )
      await new Promise((r) => setTimeout(r, 300))
      await a.query('COMMIT')
      const outcome = await pending
      await b.query(outcome === 'ok' ? 'COMMIT' : 'ROLLBACK')
      expect(outcome).toBe('EXU06')
    } finally {
      await a.end()
      await b.end()
    }
    const left = await as('exdb_serve', (c) => c.query('SELECT auth.active_owner_count() AS n'))
    expect(Number(left.rows[0]?.n)).toBe(1)
  })

  it('binds the owner role globally only, once per identity and scope; a binding is revoked once', async () => {
    const who = await identity()
    await activate(who)
    const op = await operation()
    expect(
      await refused(
        'exdb_worker',
        `INSERT INTO auth.role_bindings (binding_id, identity_id, role_id, scope_kind, scope_id, state, origin, created_by_operation_id)
         VALUES ($1, $2, 'owner', 'project', 'prj_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z', 'active', 'operation', $3)`,
        [newId('rlb', now()), who, op],
      ),
    ).toBe('23514')
    expect(
      await refused(
        'exdb_worker',
        `INSERT INTO auth.role_bindings (binding_id, identity_id, role_id, scope_kind, scope_id, state, origin, created_by_operation_id)
         VALUES ($1, $2, 'viewer', 'project', 'project:*', 'active', 'operation', $3)`,
        [newId('rlb', now()), who, op],
      ),
    ).toBe('23514')
    const binding = await bind(who, 'viewer', ['environment', 'env_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z'])
    expect(
      await refused(
        'exdb_worker',
        `INSERT INTO auth.role_bindings (binding_id, identity_id, role_id, scope_kind, scope_id, state, origin, created_by_operation_id)
         VALUES ($1, $2, 'viewer', 'environment', 'env_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z', 'active', 'operation', $3)`,
        [newId('rlb', now()), who, op],
      ),
    ).toBe('23505')
    const revoked = await as('exdb_worker', (c) =>
      c.query(
        `UPDATE auth.role_bindings SET state = 'revoked', revoked_at = now(), revoke_reason = 'operation',
                revoked_by_operation_id = $2 WHERE binding_id = $1`,
        [binding, op],
      ),
    )
    expect(revoked.rowCount).toBe(1)
    expect(
      await refused(
        'exdb_worker',
        `UPDATE auth.role_bindings SET state = 'active' WHERE binding_id = $1`,
        [binding],
      ),
    ).toBe('EXU06')
    const revision = await as('exdb_worker', (c) =>
      c.query('SELECT authz_revision FROM auth.identities WHERE identity_id = $1', [who]),
    )
    expect(Number(revision.rows[0]?.authz_revision)).toBe(3)
  })
})

describe('approvals in the database', () => {
  async function planFor(actorId: string, client: 'web' | 'mcp') {
    const planId = newId('pln', now())
    const planHash = hash()
    await as('super', (c) =>
      c.query(
        `INSERT INTO operations.plans (plan_id, kind, kind_version, action_class, state, decision, plan_hash, content_checksum,
                                       policy_version, actor_kind, actor_id, client_kind, tier, created_at, expires_at)
         VALUES ($1, 'access.identity.erase', 1, 'critical', 'active', 'require', $2, $3, $4, 'human', $5, $6, 'prod',
                 now(), now() + interval '15 minutes')`,
        [planId, planHash, hash(), `sha256:pv1:${'a'.repeat(64)}`, actorId, client],
      ),
    )
    const op = await operation('awaiting_approval', planId)
    return { planId, planHash, op }
  }

  async function session(identityId: string) {
    const ses = newId('ses', now())
    await as('exdb_serve', (c) =>
      c.query(
        `INSERT INTO auth.web_sessions (session_id, identity_id, token_hash, csrf_hash, session_epoch, assurance, created_at, absolute_expires_at, last_seen_at)
         VALUES ($1, $2, $3, $4, 1, 'full', now(), now(), now())`,
        [ses, identityId, hash(), hash()],
      ),
    )
    const rau = newId('rau', now())
    await as('exdb_serve', (c) =>
      c.query(
        `INSERT INTO auth.reauth_events (reauth_event_id, identity_id, session_id, method, factor_id, user_verified)
         VALUES ($1, $2, $3, 'passkey', $4, true)`,
        [rau, identityId, ses, newId('fac', now())],
      ),
    )
    return { ses, rau }
  }

  const approve = `INSERT INTO approvals.plan_approvals (approval_id, operation_id, plan_id, plan_hash, approver_identity_id,
                     approver_session_id, approver_client, decision, self_approval, reauth_event_id, cooling_seconds,
                     policy_version, decided_at, not_before)
                   VALUES ($1, $2, $3, $4, $5, $6, 'web', 'approved', false, $7, $8::int, $9, now(), now() + make_interval(secs => $8::int))`

  it('records self-approval itself, binds the plan hash, and refuses a second decision or any change', async () => {
    const human = await identity()
    await activate(human)
    const { ses, rau } = await session(human)
    const own = await planFor(human, 'web')
    const pv = `sha256:pv1:${'b'.repeat(64)}`
    expect(
      await refused('exdb_serve', approve, [
        newId('apr', now()),
        own.op,
        own.planId,
        hash(),
        human,
        ses,
        rau,
        600,
        pv,
      ]),
    ).toBe('EXR01')
    expect(
      await refused('exdb_serve', approve, [
        newId('apr', now()),
        own.op,
        own.planId,
        own.planHash,
        human,
        ses,
        rau,
        600,
        pv,
      ]),
    ).toBeUndefined()
    const row = await as('exdb_serve', (c) =>
      c.query(
        `SELECT self_approval, not_before - decided_at = interval '10 minutes' AS cooling
           FROM approvals.plan_approvals WHERE operation_id = $1`,
        [own.op],
      ),
    )
    expect(row.rows[0]).toEqual({ self_approval: true, cooling: true })
    expect(
      await refused('exdb_serve', approve, [
        newId('apr', now()),
        own.op,
        own.planId,
        own.planHash,
        human,
        ses,
        rau,
        0,
        pv,
      ]),
    ).toBe('23505')
    expect(
      await refused(
        'exdb_migrate',
        'DELETE FROM approvals.plan_approvals WHERE operation_id = $1',
        [own.op],
      ),
    ).toBe('EXA01')
  })

  it('an agent-initiated plan approved by the human behind it is not a self-approval', async () => {
    const human = await identity()
    await activate(human)
    const { ses, rau } = await session(human)
    const agentPlan = await planFor(human, 'mcp')
    await as('exdb_serve', (c) =>
      c.query(approve, [
        newId('apr', now()),
        agentPlan.op,
        agentPlan.planId,
        agentPlan.planHash,
        human,
        ses,
        rau,
        0,
        `sha256:pv1:${'c'.repeat(64)}`,
      ]),
    )
    const row = await as('exdb_serve', (c) =>
      c.query('SELECT self_approval FROM approvals.plan_approvals WHERE operation_id = $1', [
        agentPlan.op,
      ]),
    )
    expect(row.rows[0]).toEqual({ self_approval: false })
  })

  it('refuses an approval without a fresh passkey or TOTP re-authentication of the approving session', async () => {
    const human = await identity()
    await activate(human)
    const { ses } = await session(human)
    const stale = newId('rau', now())
    await as('exdb_serve', (c) =>
      c.query(
        `INSERT INTO auth.reauth_events (reauth_event_id, identity_id, session_id, method, factor_id, user_verified)
         VALUES ($1, $2, $3, 'totp', $4, false)`,
        [stale, human, ses, newId('fac', now())],
      ),
    )
    await as('super', (c) =>
      c.query(
        `ALTER TABLE auth.reauth_events DISABLE TRIGGER reauth_events_append_only;
         UPDATE auth.reauth_events SET occurred_at = occurred_at - interval '301 seconds' WHERE reauth_event_id = '${stale}';
         ALTER TABLE auth.reauth_events ENABLE TRIGGER reauth_events_append_only;`,
      ),
    )
    const plan = await planFor(await identity(), 'web')
    expect(
      await refused('exdb_serve', approve, [
        newId('apr', now()),
        plan.op,
        plan.planId,
        plan.planHash,
        human,
        ses,
        stale,
        0,
        `sha256:pv1:${'d'.repeat(64)}`,
      ]),
    ).toBe('EXR01')
  })
})
