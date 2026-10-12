import { randomUUID } from 'node:crypto'
import type { PlanView } from '@exponetdb/sdk'
import { header } from '../output/format.ts'
import { type CommandResult, result } from '../output/model.ts'
import { planBlocks, planNext, planTitle } from '../output/views.ts'
import { EXIT } from './exit.ts'
import { must } from './remote.ts'
import { stepUpHeader } from './stepup.ts'
import type { Remote, RunContext } from './types.ts'
import { UsageError } from './usage.ts'
import { operationResult, waits, watchOperation } from './watch.ts'

/**
 * Applying a stored plan, shared by `plan apply` and every planning command
 * with `--apply`: the target, tier and content are the plan's, never the
 * current defaults. A production plan asks for a local confirmation (or
 * `--yes`); a plan that needs a fresh proof gets it through a bound
 * step-up (ADR-0026), never through `--yes`.
 */
export function planResult(command: string, remote: Remote, p: PlanView): CommandResult {
  return result({
    command,
    status: p.decision === 'deny' ? 'failed' : p.decision === 'require' ? 'requires_action' : 'ok',
    exitCode: p.decision === 'deny' ? EXIT.blocked : EXIT.ok,
    planId: p.id,
    data: p,
    ...(p.decision === 'deny'
      ? {
          error: { code: 'PLAN_DENIED', message: 'Policy denies this plan; it cannot be applied.' },
        }
      : {}),
    next: planNext(p),
    blocks: [header(planTitle(p), remote.context), ...planBlocks(p)],
  })
}

/** Confirms a production apply on a terminal; `--yes` skips this local confirmation only. */
async function confirmProduction(ctx: RunContext, p: PlanView): Promise<void> {
  if (p.subject.tier !== 'prod' || ctx.global.yes) return
  const where =
    p.subject.targetPath ??
    p.subject.targetId ??
    p.subject.clusterId ??
    p.subject.nodeId ??
    'installation'
  if (ctx.global.noInput || !ctx.io.tty.stdin) {
    throw new UsageError(
      `Plan ${p.id} changes production (${where}); confirm on a terminal or pass --yes.`,
      `exponetdb plan apply ${p.id} --yes`,
    )
  }
  const ok = await ctx.io.confirm(`Apply plan ${p.id} (${p.kind}) to ${where} on production?`)
  if (!ok) throw new UsageError('Not applied.')
}

/**
 * Applies a stored plan and, by default, watches its operation until it is
 * applied and verified. A plan whose apply needs a fresh re-authentication
 * gets it through a bound step-up (ADR-0026), never through `--yes`.
 */
export async function applyPlan(
  ctx: RunContext,
  remote: Remote,
  command: string,
  plan: PlanView,
  flags: Readonly<Record<string, unknown>>,
): Promise<CommandResult> {
  const wait = waits(flags)
  await confirmProduction(ctx, plan)
  ctx.hint(
    `Applying ${plan.id} (${plan.kind}) on ${remote.server}${remote.profile === undefined ? '' : ` [${remote.profile.name}]`} to ${plan.subject.targetPath ?? plan.subject.targetId ?? plan.subject.clusterId ?? plan.subject.nodeId ?? 'installation'} (${plan.subject.tier ?? 'no tier'}).`,
  )
  const key = randomUUID()
  const given = typeof flags['step-up'] === 'string' ? flags['step-up'] : undefined
  let applied = await remote.sdk.call('applyPlan', {
    params: { planId: plan.id },
    body: {},
    idempotencyKey: key,
    ...(given === undefined ? {} : { stepUp: given }),
  })
  if (!applied.ok && applied.error.code === 'REAUTH_REQUIRED' && given === undefined) {
    const stepUp = await stepUpHeader(ctx, remote, { action: 'plan.apply', planId: plan.id })
    applied = await remote.sdk.call('applyPlan', {
      params: { planId: plan.id },
      body: {},
      idempotencyKey: key,
      stepUp,
    })
  }
  const operation = must(applied)
  if (!wait) {
    return operationResult(command, remote, operation, {
      status: operation.state === 'succeeded' ? 'ok' : 'accepted',
      exitCode: EXIT.ok,
    })
  }
  return watchOperation(ctx, remote, command, operation, Number(flags['timeout-wait'] ?? 900_000))
}
