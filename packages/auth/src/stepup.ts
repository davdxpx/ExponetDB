import { createHash, timingSafeEqual } from 'node:crypto'
import { appendAuditEvent } from '@exponetdb/audit'
import type { StepUpView } from '@exponetdb/contracts'
import type { Queryable, Row, Tx } from '@exponetdb/control-store'
import { type Clock, canonicalBytes, type IdentityId, isId, newId } from '@exponetdb/kernel'
import { humanActor, webClient } from './audit.ts'
import { AuthError } from './errors.ts'
import type { DelegatedPrincipal } from './oauth/bearer.ts'
import { newUserCode, normalizeUserCode } from './oauth/device.ts'
import type { SessionContext } from './sessions.ts'
import { tokenHash } from './tokens.ts'

/**
 * CLI step-ups ([ADR-0026](../../../exponetdb-docs/01-architecture/adr/0026-cli-step-up-browser-handoff.md)).
 * A person's first-party CLI asks for a fresh proof of presence for one
 * bound action; the same person confirms it in a signed-in browser with a
 * fresh passkey or TOTP proof; the bound request redeems the receipt once,
 * in its own transaction. The binding is built from server state only
 * (installation, identity, client, grant, action, plan id and hash or
 * token id); a client timestamp or flag never counts.
 */
export const STEP_UP_ACTIONS = ['plan.apply', 'node.enrollment_token.reveal'] as const
export type StepUpAction = (typeof STEP_UP_ACTIONS)[number]

export function isStepUpAction(value: string): value is StepUpAction {
  return (STEP_UP_ACTIONS as readonly string[]).includes(value)
}

const STEP_UP_SECONDS = 600
const RECEIPT_SECONDS = 120
const MAX_CODE_ATTEMPTS = 5

export interface StepUpBinding {
  readonly installationId: string
  readonly identityId: string
  readonly clientId: string
  readonly grantId: string
  readonly action: StepUpAction
  readonly planId: string | null
  readonly planHash: string | null
  readonly tokenId: string | null
}

/** `sha256:` over the JCS of the binding (with a version tag). */
export function stepUpBindingDigest(binding: StepUpBinding): string {
  const bytes = canonicalBytes({ v: 'exponetdb/step-up/v1', ...binding })
  if (!bytes.ok) throw new AuthError('INTERNAL')
  return `sha256:${createHash('sha256').update(bytes.value).digest('hex')}`
}

/** The person's own first-party CLI grant behind a delegated principal, or undefined. */
export function ownCliGrant(
  principal: DelegatedPrincipal,
):
  | { readonly identityId: IdentityId; readonly clientId: string; readonly grantId: string }
  | undefined {
  const credential = principal.delegation.credential
  if (
    principal.identityKind !== 'human' ||
    principal.client !== 'cli' ||
    credential.type !== 'access_token' ||
    credential.grantKind !== 'delegated'
  ) {
    return undefined
  }
  return {
    identityId: principal.identityId,
    clientId: credential.clientId,
    grantId: credential.grantId,
  }
}

const ts = (expr: string, alias: string) =>
  `to_char((${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${alias}`

const COLUMNS = `s.step_up_id, s.identity_id, s.client_id, s.grant_id, s.action, s.plan_id, s.plan_hash, s.token_id,
  s.binding_digest, s.user_code_hash, s.state, s.attempts,
  ${ts('s.expires_at', 'expires_at')}, ${ts('s.receipt_expires_at', 'receipt_expires_at')}, ${ts('s.reauth_at', 'reauth_at')},
  (s.expires_at <= clock_timestamp()) AS expired,
  (s.receipt_expires_at IS NOT NULL AND s.receipt_expires_at <= clock_timestamp()) AS receipt_expired,
  GREATEST(0, ceil(extract(epoch FROM clock_timestamp() - s.reauth_at)))::int AS reauth_age_seconds,
  c.display_name AS client_name,
  (g.state = 'active' AND g.expires_at > clock_timestamp()) AS grant_active`

const FROM = `FROM stepup.step_ups s
  JOIN oauth.clients c ON c.client_id = s.client_id
  JOIN oauth.grants g ON g.grant_id = s.grant_id`

/** The state a person sees: a pending or confirmed step-up past its time reads as expired. */
function effectiveState(row: Row): StepUpView['state'] {
  const state = row.text('state') as StepUpView['state']
  if (state === 'pending' && row.boolOrNull('expired') === true) return 'expired'
  if (state === 'confirmed' && row.boolOrNull('receipt_expired') === true) return 'expired'
  return state
}

function viewOf(row: Row, origin: string, userCode: string | null): StepUpView {
  const id = row.text('step_up_id')
  return {
    id: id as StepUpView['id'],
    action: row.text('action'),
    state: effectiveState(row),
    bindingDigest: row.text('binding_digest') as StepUpView['bindingDigest'],
    planHash: row.textOrNull('plan_hash') as StepUpView['planHash'],
    verificationUri: `${origin}/step-up#id=${id}`,
    userCode,
    clientName: row.textOrNull('client_name'),
    expiresAt: row.text('expires_at'),
    receiptExpiresAt: row.textOrNull('receipt_expires_at'),
  }
}

async function load(q: Queryable, stepUpId: string, lock: boolean): Promise<Row | undefined> {
  if (!isId('stu', stepUpId)) return undefined
  const { rows } = await q.query(
    'auth.step_up.load',
    `SELECT ${COLUMNS} ${FROM} WHERE s.step_up_id = $1${lock ? ' FOR UPDATE OF s' : ''}`,
    [stepUpId],
  )
  return rows[0]
}

function cliClient(binding: { readonly clientId: string; readonly grantId: string }) {
  return {
    clientId: binding.clientId as never,
    kind: 'cli' as const,
    grantId: binding.grantId as never,
  }
}

/** Records a new step-up for a binding the caller built from server state; the code is shown once. */
export async function createStepUp(
  tx: Tx,
  deps: { readonly clock: Clock },
  binding: StepUpBinding,
  actor: { readonly label: string },
  origin: string,
): Promise<StepUpView> {
  const stepUpId = newId('stu', deps.clock.nowMs())
  const userCode = newUserCode()
  const digest = stepUpBindingDigest(binding)
  await tx.query(
    'auth.step_up.insert',
    // One clock reading for both times: the table checks the expiry against the creation.
    `INSERT INTO stepup.step_ups (step_up_id, identity_id, client_id, grant_id, action, plan_id, plan_hash, token_id,
                                  binding_digest, user_code_hash, created_at, expires_at)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now.t, now.t + make_interval(secs => $11::int)
       FROM (SELECT clock_timestamp() AS t) now`,
    [
      stepUpId,
      binding.identityId,
      binding.clientId,
      binding.grantId,
      binding.action,
      binding.planId,
      binding.planHash,
      binding.tokenId,
      digest,
      tokenHash('user_code', normalizeUserCode(userCode) ?? ''),
      STEP_UP_SECONDS,
    ],
  )
  await appendAuditEvent(
    tx,
    {
      action: 'step_up.requested',
      phase: 'completed',
      actor: {
        kind: 'human',
        identityId: binding.identityId as never,
        label: actor.label as never,
      },
      client: cliClient(binding),
      refs: {
        ...(binding.planId === null ? {} : { planId: binding.planId as never }),
        ...(binding.planHash === null ? {} : { planHash: binding.planHash as never }),
      },
      changes: { stepUpId, boundAction: binding.action, bindingDigest: digest },
      result: { status: 'succeeded' },
    },
    { clock: deps.clock },
  )
  const row = await load(tx, stepUpId, false)
  if (row === undefined) throw new AuthError('INTERNAL')
  return viewOf(row, origin, userCode)
}

/** A step-up of this identity (anything else reads as not found). */
export async function readStepUp(
  q: Queryable,
  identityId: IdentityId,
  stepUpId: string,
  origin: string,
): Promise<StepUpView> {
  const row = await load(q, stepUpId, false)
  if (row === undefined || row.text('identity_id') !== identityId) throw new AuthError('NOT_FOUND')
  return viewOf(row, origin, null)
}

/**
 * Confirms a pending step-up in the Web App: the same identity, the code
 * the CLI shows (five attempts), a grant still active. The engine already
 * required a fresh passkey or TOTP proof of this session (`step_up.confirm`);
 * the receipt starts now and lasts 120 seconds.
 */
export type ConfirmResult =
  | { readonly ok: true; readonly view: StepUpView }
  /** Refused, with the counted attempt or the refusal kept: the caller commits, then answers. */
  | { readonly ok: false; readonly reason: 'code_mismatch' | 'code_attempts' | 'grant_revoked' }

export async function confirmStepUp(
  tx: Tx,
  deps: { readonly clock: Clock },
  session: SessionContext,
  stepUpId: string,
  userCode: string,
  origin: string,
): Promise<ConfirmResult> {
  const row = await load(tx, stepUpId, true)
  if (row === undefined || row.text('identity_id') !== session.identityId)
    throw new AuthError('NOT_FOUND')
  if (effectiveState(row) !== 'pending') {
    throw new AuthError('CONFLICT')
  }
  if (
    session.reauthAt === null ||
    (session.reauthMethod !== 'passkey' && session.reauthMethod !== 'totp')
  ) {
    throw new AuthError('REAUTH_REQUIRED')
  }
  const binding = { clientId: row.text('client_id'), grantId: row.text('grant_id') }
  if (row.boolOrNull('grant_active') !== true) {
    await tx.query(
      'auth.step_up.refuse',
      `UPDATE stepup.step_ups SET state = 'refused', refused_reason = 'grant_revoked' WHERE step_up_id = $1`,
      [stepUpId],
    )
    await refusedEvent(tx, deps, session, binding, stepUpId, 'grant_revoked')
    return { ok: false, reason: 'grant_revoked' }
  }
  const expected = Buffer.from(row.text('user_code_hash'))
  const given = Buffer.from(tokenHash('user_code', normalizeUserCode(userCode) ?? ''))
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    const attempts = row.int('attempts') + 1
    await tx.query(
      'auth.step_up.attempt',
      `UPDATE stepup.step_ups
          SET attempts = $2::int,
              state = CASE WHEN $2::int >= $3::int THEN 'refused' ELSE state END,
              refused_reason = CASE WHEN $2::int >= $3::int THEN 'code_attempts' ELSE refused_reason END
        WHERE step_up_id = $1`,
      [stepUpId, attempts, MAX_CODE_ATTEMPTS],
    )
    if (attempts >= MAX_CODE_ATTEMPTS) {
      await refusedEvent(tx, deps, session, binding, stepUpId, 'code_attempts')
      return { ok: false, reason: 'code_attempts' }
    }
    return { ok: false, reason: 'code_mismatch' }
  }
  await tx.query(
    'auth.step_up.confirm',
    // One clock reading: the receipt's expiry is checked against the confirmation time.
    `UPDATE stepup.step_ups
        SET state = 'confirmed', confirmed_at = now.t, confirmed_session = $2,
            reauth_at = $3::timestamptz, reauth_method = $4,
            receipt_expires_at = now.t + make_interval(secs => $5::int)
       FROM (SELECT clock_timestamp() AS t) now
      WHERE step_up_id = $1`,
    [stepUpId, session.sessionId, session.reauthAt, session.reauthMethod, RECEIPT_SECONDS],
  )
  await appendAuditEvent(
    tx,
    {
      action: 'step_up.confirmed',
      phase: 'completed',
      actor: humanActor(session, session.reauthAt),
      client: webClient(session.sessionId),
      changes: {
        stepUpId,
        bindingDigest: row.text('binding_digest'),
        confirmedFor: cliClient(binding).clientId,
      },
      result: { status: 'succeeded' },
    },
    { clock: deps.clock },
  )
  const after = await load(tx, stepUpId, false)
  if (after === undefined) throw new AuthError('INTERNAL')
  return { ok: true, view: viewOf(after, origin, null) }
}

async function refusedEvent(
  tx: Tx,
  deps: { readonly clock: Clock },
  session: SessionContext,
  binding: { readonly clientId: string; readonly grantId: string },
  stepUpId: string,
  reason: 'code_attempts' | 'grant_revoked',
): Promise<void> {
  await appendAuditEvent(
    tx,
    {
      action: 'step_up.refused',
      phase: 'denied',
      actor: humanActor(session, session.reauthAt),
      client: webClient(session.sessionId),
      changes: { stepUpId, reason, client: binding.clientId },
      result: { status: 'denied' },
    },
    { clock: deps.clock },
  )
}

/** Cancels an own pending or confirmed step-up (from the CLI or the Web App). */
export async function cancelStepUp(
  tx: Tx,
  identityId: IdentityId,
  stepUpId: string,
  origin: string,
): Promise<StepUpView> {
  const row = await load(tx, stepUpId, true)
  if (row === undefined || row.text('identity_id') !== identityId) throw new AuthError('NOT_FOUND')
  const state = row.text('state')
  if (state === 'pending' || state === 'confirmed') {
    await tx.query(
      'auth.step_up.cancel',
      `UPDATE stepup.step_ups SET state = 'canceled' WHERE step_up_id = $1`,
      [stepUpId],
    )
  }
  const after = await load(tx, stepUpId, false)
  if (after === undefined) throw new AuthError('INTERNAL')
  return viewOf(after, origin, null)
}

/** A confirmed, matching receipt, ready to be marked redeemed with the bound request. */
export interface StepUpReceipt {
  readonly stepUpId: string
  readonly reauthAt: string
  readonly reauthAgeSeconds: number
  readonly bindingDigest: string
}

/**
 * The receipt of `stepUpId` when it matches `binding` exactly (recomputed
 * by the caller from the request and its own state), is confirmed,
 * unexpired and unredeemed, and its grant is active; else undefined. The
 * row stays locked until the request's transaction ends.
 */
export async function matchingReceipt(
  tx: Tx,
  stepUpId: string,
  binding: StepUpBinding,
): Promise<StepUpReceipt | undefined> {
  const row = await load(tx, stepUpId, true)
  if (
    row === undefined ||
    row.text('state') !== 'confirmed' ||
    row.boolOrNull('receipt_expired') !== false ||
    row.boolOrNull('grant_active') !== true ||
    row.text('identity_id') !== binding.identityId ||
    row.text('client_id') !== binding.clientId ||
    row.text('grant_id') !== binding.grantId ||
    row.text('action') !== binding.action ||
    row.text('binding_digest') !== stepUpBindingDigest(binding)
  ) {
    return undefined
  }
  const reauthAt = row.textOrNull('reauth_at')
  const age = row.intOrNull('reauth_age_seconds')
  if (reauthAt === null || age === null) return undefined
  return { stepUpId, reauthAt, reauthAgeSeconds: age, bindingDigest: row.text('binding_digest') }
}

/** Marks a receipt redeemed in the bound request's transaction (a failed request rolls it back). */
export async function redeemReceipt(
  tx: Tx,
  deps: { readonly clock: Clock },
  receipt: StepUpReceipt,
  binding: StepUpBinding,
  actor: { readonly label: string },
): Promise<void> {
  await tx.query(
    'auth.step_up.redeem',
    `UPDATE stepup.step_ups SET state = 'redeemed', redeemed_at = clock_timestamp()
      WHERE step_up_id = $1 AND state = 'confirmed'`,
    [receipt.stepUpId],
  )
  await appendAuditEvent(
    tx,
    {
      action: 'step_up.redeemed',
      phase: 'completed',
      actor: {
        kind: 'human',
        identityId: binding.identityId as never,
        label: actor.label as never,
        reauthAt: receipt.reauthAt,
      },
      client: cliClient(binding),
      refs: {
        ...(binding.planId === null ? {} : { planId: binding.planId as never }),
        ...(binding.planHash === null ? {} : { planHash: binding.planHash as never }),
      },
      changes: {
        stepUpId: receipt.stepUpId,
        boundAction: binding.action,
        bindingDigest: receipt.bindingDigest,
      },
      result: { status: 'succeeded' },
    },
    { clock: deps.clock },
  )
}
