import { expectOk, type IdentityId, parseId } from '@exponetdb/kernel'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  auditRequest,
  deliveryStatus,
  disableIdentity,
  dispatchNotifications,
  enrollment,
  finishPasskeyLogin,
  inviteIdentity,
  isAuthError,
  loadSession,
  type OperatorDeps,
  parseRecoveryReason,
  recoverOwner,
  reissueInvitation,
  type SessionContext,
  startPasskeyLogin,
} from '../src/index.ts'
import {
  ceremonyHandle,
  type Enrolled,
  enrollFirstOwner,
  enrollThroughLink,
  errorCode,
  type Harness,
  harness,
  meta,
  ORIGIN,
  RecordingChannel,
  RP_ID,
  sessionSecrets,
  tokenOf,
  UA,
  value,
} from './support/flows.ts'

/**
 * Invitations, disabling, the last-owner invariant and out-of-band
 * recovery against PostgreSQL 17 (G3A items 4, 6, 21).
 */
let h: Harness
let owner: Enrolled
let ownerSession: SessionContext
const channel = new RecordingChannel()

beforeAll(async () => {
  h = await harness('exdb_it_auth_ident', channel)
  owner = await enrollFirstOwner(h)
  const loaded = await loadSession(h.deps.store, owner.session.token, { userAgent: UA })
  if (loaded === undefined) {
    throw new Error('owner session')
  }
  ownerSession = loaded
})

afterAll(async () => {
  await h?.db.drop()
})

async function caught(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    return isAuthError(error) ? error.code : String(error)
  }
}

const idn = (value: string): IdentityId => expectOk(parseId('idn', value), 'identity id')

const operator = (): OperatorDeps => ({
  store: h.deps.store,
  clock: h.clock,
  config: h.deps.config,
  channel: h.deps.channel,
})

describe('invitations', () => {
  let invitedLink = ''
  let invitedId = ''

  it('invites without any role; the delivery outcome is reported truthfully', async () => {
    const request = await auditRequest(h.deps.keys, meta())
    const result = await h.deps.store.transaction('test.invite', (tx) =>
      inviteIdentity(tx, h.deps, ownerSession, request, {
        email: 'dev@example.test',
        displayName: 'Dev',
      }),
    )
    expect(result.identity.state).toBe('invited')
    expect(new URL(result.link).pathname).toBe('/invite')
    expect(tokenOf(result.link)).toMatch(/^exiv_/)
    const outcomes = await dispatchNotifications(h.deps.store, channel, [result.delivery])
    expect(deliveryStatus(h.deps, [...outcomes.values()][0])).toEqual({
      status: 'sent',
      channel: 'email',
    })
    expect(channel.sent.at(-1)).toMatchObject({ kind: 'auth.invitation', to: 'dev@example.test' })
    expect(deliveryStatus({ channel: undefined }, undefined)).toEqual({
      status: 'not_configured',
      channel: 'none',
    })
    const ttl = await h.db.asSuperuser(
      async (c) =>
        (
          await c.query(
            `SELECT expires_at - created_at = interval '24 hours' AS exact FROM auth.capabilities
            WHERE identity_id = $1 AND kind = 'invitation'`,
            [result.identity.id],
          )
        ).rows[0].exact,
    )
    expect(ttl).toBe(true)
    invitedLink = result.link
    invitedId = result.identity.id
    const roles = await h.db.asSuperuser(
      async (c) =>
        (
          await c.query(
            'SELECT count(*)::int AS n FROM auth.role_bindings WHERE identity_id = $1',
            [invitedId],
          )
        ).rows[0].n,
    )
    expect(roles).toBe(0)
  })

  it('a failing channel is recorded as failed, never as sent', async () => {
    channel.fail = true
    try {
      const request = await auditRequest(h.deps.keys, meta())
      const result = await h.deps.store.transaction('test.invite', (tx) =>
        inviteIdentity(tx, h.deps, ownerSession, request, { email: 'ops@example.test' }),
      )
      const outcomes = await dispatchNotifications(h.deps.store, channel, [result.delivery])
      expect(deliveryStatus(h.deps, [...outcomes.values()][0])).toEqual({
        status: 'failed',
        channel: 'email',
      })
      const status = await h.db.asSuperuser(
        async (c) =>
          (
            await c.query(
              `SELECT status, error_code FROM auth.notifications WHERE recipient_identity_id = $1`,
              [result.identity.id],
            )
          ).rows,
      )
      expect(status).toEqual([{ status: 'failed', error_code: 'smtp_refused' }])
    } finally {
      channel.fail = false
    }
  })

  it('refuses a second identity with the same address, case-insensitively', async () => {
    const request = await auditRequest(h.deps.keys, meta())
    expect(
      await caught(
        h.deps.store.transaction('test.invite', (tx) =>
          inviteIdentity(tx, h.deps, ownerSession, request, { email: 'DEV@example.test' }),
        ),
      ),
    ).toBe('IDENTITY_EXISTS')
  })

  it('a re-issued invitation replaces the old link', async () => {
    const request = await auditRequest(h.deps.keys, meta())
    const reissued = await h.deps.store.transaction('test.reissue', (tx) =>
      reissueInvitation(tx, h.deps, ownerSession, request, idn(invitedId)),
    )
    expect(errorCode(await enrollment.redeem(h.deps, meta(), tokenOf(invitedLink)))).toBe(
      'LINK_INVALID',
    )
    invitedLink = reissued.link
  })

  it('the invited person enrolls and becomes active, still without a role', async () => {
    const dev = await enrollThroughLink(h, invitedLink, 'dev@example.test')
    expect(dev.identityId).toBe(invitedId)
    const state = await h.db.asSuperuser(
      async (c) =>
        (
          await c.query(
            `SELECT i.state, (SELECT count(*)::int FROM auth.role_bindings b WHERE b.identity_id = i.identity_id) AS roles
             FROM auth.identities i WHERE identity_id = $1`,
            [invitedId],
          )
        ).rows[0],
    )
    expect(state).toEqual({ state: 'active', roles: 0 })
    const request = await auditRequest(h.deps.keys, meta())
    expect(
      await caught(
        h.deps.store.transaction('test.reissue', (tx) =>
          reissueInvitation(tx, h.deps, ownerSession, request, idn(invitedId)),
        ),
      ),
    ).toBe('IDENTITY_STATE_INVALID')
  })
})

describe('disabling and the last owner', () => {
  it('disabling ends the sessions and links of an identity at once', async () => {
    const request = await auditRequest(h.deps.keys, meta())
    const invited = await h.deps.store.transaction('test.invite', (tx) =>
      inviteIdentity(tx, h.deps, ownerSession, request, { email: 'temp@example.test' }),
    )
    const enrolled = await enrollThroughLink(h, invited.link, 'temp@example.test')
    expect(await loadSession(h.deps.store, enrolled.session.token, { userAgent: UA })).toBeDefined()
    const disabled = await h.deps.store.transaction('test.disable', (tx) =>
      disableIdentity(tx, h.deps, ownerSession, request, idn(invited.identity.id), 'left the team'),
    )
    expect(disabled.identity.state).toBe('disabled')
    expect(
      await loadSession(h.deps.store, enrolled.session.token, { userAgent: UA }),
    ).toBeUndefined()
    // Passkey sign-in of a disabled identity fails.
    const m = meta()
    const started = await startPasskeyLogin(h.deps, m)
    const assertion = enrolled.authenticator.assert({
      challenge: value(started).challenge,
      origin: ORIGIN,
      rpId: RP_ID,
    })
    expect(errorCode(await finishPasskeyLogin(h.deps, m, ceremonyHandle(started), assertion))).toBe(
      'AUTHENTICATION_FAILED',
    )
  })

  it('refuses to disable the last owner, also when the owner tries it on themselves', async () => {
    const request = await auditRequest(h.deps.keys, meta())
    expect(
      await caught(
        h.deps.store.transaction('test.disable', (tx) =>
          disableIdentity(tx, h.deps, ownerSession, request, idn(owner.identityId), undefined),
        ),
      ),
    ).toBe('OWNER_INVARIANT')
    expect(await loadSession(h.deps.store, owner.session.token, { userAgent: UA })).toBeDefined()
  })
})

describe('out-of-band recovery of the last owner', () => {
  it('requires a written reason of 20 to 1000 characters', () => {
    expect(() => parseRecoveryReason('lost')).toThrow()
    expect(() => parseRecoveryReason('x'.repeat(1001))).toThrow()
    expect(() => parseRecoveryReason('lost phone \u0007 and key')).toThrow()
    expect(parseRecoveryReason('  Laptop and phone were stolen on 2026-10-05.\n')).toBe(
      'Laptop and phone were stolen on 2026-10-05.',
    )
  })

  it('refuses an address that is not the last active owner', async () => {
    expect(
      await caught(
        recoverOwner(operator(), {
          email: 'dev@example.test',
          reason: 'This person is not an owner at all.',
        }),
      ),
    ).toBe('recovery_no_owner')
  })

  it('ends every session, issues a single-use 30-minute link, audits and replaces every factor', async () => {
    const result = await recoverOwner(operator(), {
      email: owner.email,
      reason: 'Lost every passkey and the authenticator device.',
    })
    expect(result.sessionsEnded).toBeGreaterThanOrEqual(1)
    expect(new URL(result.link).pathname).toBe('/recover')
    expect(await loadSession(h.deps.store, owner.session.token, { userAgent: UA })).toBeUndefined()
    const audit = await h.db.asSuperuser(async (c) =>
      (
        await c.query(
          `SELECT event::jsonb AS e FROM audit.audit_events WHERE action = 'auth.out_of_band_recovery_used'`,
        )
      ).rows.map((r) => r.e),
    )
    expect(audit).toHaveLength(1)
    expect(audit[0].reason).toBe('Lost every passkey and the authenticator device.')
    expect(audit[0].actor.label).toBe('system:maintenance')
    expect(JSON.stringify(audit[0])).not.toContain('@example.test')
    expect(channel.sent.some((n) => n.kind === 'auth.out_of_band_recovery')).toBe(true)

    // The old passkey no longer signs in once the recovery link is redeemed.
    const recovered = await enrollThroughLink(h, result.link, owner.email)
    expect(recovered.identityId).toBe(owner.identityId)
    expect(errorCode(await enrollment.redeem(h.deps, meta(), tokenOf(result.link)))).toBe(
      'LINK_INVALID',
    )
    const m = meta()
    const started = await startPasskeyLogin(h.deps, m)
    const oldAssertion = owner.authenticator.assert({
      challenge: value(started).challenge,
      origin: ORIGIN,
      rpId: RP_ID,
    })
    expect(
      errorCode(await finishPasskeyLogin(h.deps, m, ceremonyHandle(started), oldAssertion)),
    ).toBe('AUTHENTICATION_FAILED')
    const fresh = await startPasskeyLogin(h.deps, m)
    const newAssertion = recovered.authenticator.assert({
      challenge: value(fresh).challenge,
      origin: ORIGIN,
      rpId: RP_ID,
    })
    const signedIn = await finishPasskeyLogin(h.deps, m, ceremonyHandle(fresh), newAssertion)
    expect(value(signedIn).recoveryRequired).toBe(false)
    expect(sessionSecrets(signedIn).token).toMatch(/^exst_/)
    const roles = await h.db.asSuperuser(
      async (c) =>
        (
          await c.query(
            `SELECT role_id FROM auth.role_bindings WHERE identity_id = $1 AND state = 'active'`,
            [owner.identityId],
          )
        ).rows,
    )
    expect(roles).toEqual([{ role_id: 'owner' }])
  })
})
