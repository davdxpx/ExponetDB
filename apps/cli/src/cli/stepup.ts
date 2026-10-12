import type { StepUp } from '@exponetdb/sdk'
import { CliError } from '../errors.ts'
import { must } from './remote.ts'
import type { Remote, RunContext } from './types.ts'

/**
 * The CLI side of a step-up ([ADR-0026](../../../../exponetdb-docs/01-architecture/adr/0026-cli-step-up-browser-handoff.md)):
 * the server binds a step-up to this action and its object; the person
 * confirms it in a signed-in browser with the code shown here and a fresh
 * passkey or authenticator proof; the CLI then repeats the bound request
 * once with the receipt. `--yes` never replaces it, and `--no-input` ends
 * with exit 3 instead of opening a browser.
 */
export interface StepUpTarget {
  readonly action: 'plan.apply' | 'node.enrollment_token.reveal'
  readonly planId?: string
  readonly tokenId?: string
}

const POLL_MS = 2000

/** Requests a step-up, shows where and what to confirm, and waits for the confirmation. */
export async function stepUpHeader(
  ctx: RunContext,
  remote: Remote,
  target: StepUpTarget,
): Promise<string> {
  if (ctx.global.noInput) {
    throw new CliError(
      'REAUTH_REQUIRED',
      'This action needs a fresh proof of presence in the browser; run it without --no-input, or confirm a step-up with `exponetdb auth reauth` first.',
    )
  }
  const created = must(
    await remote.sdk.call('requestStepUp', {
      body: {
        action: target.action,
        ...(target.planId === undefined ? {} : { planId: target.planId }),
        ...(target.tokenId === undefined ? {} : { tokenId: target.tokenId }),
      },
    }),
  )
  ctx.io.stderr(`This needs a fresh confirmation in your browser.\n`)
  ctx.io.stderr(`Open ${created.verificationUri}\n`)
  ctx.io.stderr(
    `Code: ${created.userCode ?? '(see the browser)'} (check that the page shows this code; confirm only commands you started)\n`,
  )
  ctx.io.openBrowser(created.verificationUri)
  return waitForConfirmation(ctx, remote, created)
}

/** Polls the step-up until it is confirmed, refused, canceled or expired. */
export async function waitForConfirmation(
  ctx: RunContext,
  remote: Remote,
  created: StepUp,
): Promise<string> {
  const until = Date.parse(created.expiresAt)
  const timeout = () =>
    new CliError('REAUTH_REQUIRED', 'The confirmation was not completed in time; start again.')
  for (;;) {
    try {
      await ctx.io.sleep(POLL_MS, ctx.io.signal)
    } catch {
      await remote.sdk.call('cancelStepUp', { params: { stepUpId: created.id }, body: {} })
      throw new CliError('interrupted', 'Interrupted; the step-up is canceled.')
    }
    const read = await remote.sdk.call('getStepUp', { params: { stepUpId: created.id } })
    const state = read.ok ? read.value.state : 'unreadable'
    if (state === 'confirmed') {
      ctx.hint('Confirmed in the browser.')
      return created.id
    }
    if (state === 'pending' || state === 'unreadable') {
      if (ctx.io.now() > until) throw timeout()
      continue
    }
    if (state === 'refused') {
      throw new CliError(
        'REAUTH_REQUIRED',
        'The confirmation was refused (wrong codes, or the sign-in was revoked).',
      )
    }
    if (state === 'canceled')
      throw new CliError('REAUTH_REQUIRED', 'The confirmation was canceled in the browser.')
    throw new CliError('REAUTH_REQUIRED', `The confirmation is ${state}; start again.`)
  }
}
