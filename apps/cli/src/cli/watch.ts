import type { Operation } from '@exponetdb/sdk'
import { CliError } from '../errors.ts'
import { header } from '../output/format.ts'
import type { CommandResult, SafeError, Status } from '../output/model.ts'
import { operationBlocks, operationNext } from '../output/views.ts'
import { EXIT, exitFor } from './exit.ts'
import type { FlagSpec, Remote, RunContext } from './types.ts'

/**
 * Watching an operation ([`15-cli/README.md` §6](../../../../exponetdb-docs/15-cli/README.md#6-watching-operations)):
 * polls `GET /operations/{id}` with bounded backoff (the SDK honors
 * `Retry-After`), reports each change, and ends at a final state, at the
 * deadline, or on Ctrl-C. A lost connection makes the shown state stale,
 * never failed; the server operation continues whatever the CLI does.
 */
export const WAIT_FLAGS: readonly FlagSpec[] = [
  { name: 'wait', type: 'boolean', description: 'Wait until applied and verified (the default).' },
  {
    name: 'no-wait',
    type: 'boolean',
    description: 'Return once the server accepted the operation.',
  },
  {
    name: 'timeout-wait',
    type: 'duration',
    placeholder: 'duration',
    description: 'How long to wait for the outcome (default 15m).',
    default: 900_000,
  },
]

const FINAL = new Set<Operation['state']>([
  'succeeded',
  'failed',
  'verification_failed',
  'canceled',
  'needs_attention',
])

/** The result of an operation as the CLI reports it (status and exit code). */
export function operationOutcome(o: Operation): { status: Status; exitCode: number } {
  switch (o.state) {
    case 'succeeded':
      return { status: 'ok', exitCode: EXIT.ok }
    case 'failed':
    case 'verification_failed':
    case 'canceled':
      return { status: 'failed', exitCode: EXIT.failure }
    case 'needs_attention':
      return { status: 'failed', exitCode: EXIT.unresolved }
    case 'awaiting_approval':
      return { status: 'requires_action', exitCode: EXIT.blocked }
    default:
      return { status: 'accepted', exitCode: EXIT.unresolved }
  }
}

/**
 * The result of an operation. `extra` overrides the defaults; `error: null`
 * reports none (a read of an operation in any state is a successful read).
 */
export function operationResult(
  command: string,
  remote: Remote,
  o: Operation,
  extra: Omit<Partial<CommandResult>, 'error'> & { readonly error?: SafeError | null } = {},
): CommandResult {
  const outcome = operationOutcome(o)
  const status = extra.status ?? outcome.status
  const fallback: SafeError | undefined =
    o.errorCode === null || status === 'ok'
      ? undefined
      : { code: o.errorCode, message: `The operation ended ${o.state.replaceAll('_', ' ')}.` }
  const error = extra.error === null ? undefined : (extra.error ?? fallback)
  const { error: _ignored, ...rest } = extra
  return {
    command,
    status,
    exitCode: outcome.exitCode,
    data: o,
    operationId: o.id,
    ...(o.planId === null ? {} : { planId: o.planId }),
    next: operationNext(o),
    blocks: [header(`Operation ${o.id} · ${o.kind}`, remote.context), ...operationBlocks(o)],
    ...rest,
    ...(error === undefined ? {} : { error }),
  }
}

/** A line describing a change while watching. */
function progressLine(o: Operation, stale: boolean): string {
  const running = o.steps.findLast((s) => s.state === 'running')
  const migration = o.migrations?.find(
    (m) => m.applyOutcome === 'not_started' || m.verificationOutcome === 'pending',
  )
  const parts = [
    `${o.state}`,
    `apply ${o.applyOutcome}`,
    `verify ${o.verificationOutcome}`,
    ...(running === undefined ? [] : [`step ${running.name}`]),
    ...(migration === undefined || migration.statementIndex === null
      ? []
      : [`${migration.name} statement ${migration.statementIndex}`]),
    ...(o.waitingFor === null ? [] : [`waiting for ${o.waitingFor.operationId}`]),
    ...(stale ? ['(stale: the server did not answer)'] : []),
  ]
  return parts.join(' · ')
}

export async function watchOperation(
  ctx: RunContext,
  remote: Remote,
  command: string,
  first: Operation,
  deadlineMs: number,
): Promise<CommandResult> {
  const until = ctx.io.now() + deadlineMs
  let current = first
  let seen = ''
  let interval = 1000
  let stale = false
  let toldApproval = false
  for (;;) {
    const key = `${current.state}|${current.lastEventId ?? current.updatedAt}|${stale}`
    if (key !== seen) {
      seen = key
      interval = 1000
      ctx.progress(progressLine(current, stale), {
        operationId: current.id,
        state: current.state,
        applyOutcome: current.applyOutcome,
        verificationOutcome: current.verificationOutcome,
        stale,
        observedAt: current.observedAt ?? null,
      })
    }
    if (FINAL.has(current.state)) return operationResult(command, remote, current)
    if (current.state === 'awaiting_approval') {
      if (ctx.global.noInput) return operationResult(command, remote, current)
      if (!toldApproval && current.approvalUrl !== null) {
        toldApproval = true
        ctx.hint(`Approval needed: ${current.approvalUrl} (an approver signs in there; waiting).`)
      }
    }
    if (ctx.io.now() >= until) {
      return operationResult(command, remote, current, {
        status: 'error',
        exitCode: EXIT.unresolved,
        error: {
          code: 'WATCH_TIMEOUT',
          message: `The operation is ${current.state.replaceAll('_', ' ')} after the wait; it continues on the server.`,
        },
        next: [`exponetdb operation watch ${current.id}`],
      })
    }
    try {
      await ctx.io.sleep(Math.min(interval, Math.max(0, until - ctx.io.now())), ctx.io.signal)
    } catch {
      return interrupted(command, remote, current)
    }
    interval = Math.min(5000, Math.round(interval * 1.5))
    const next = await remote.sdk.call('getOperation', { params: { operationId: current.id } })
    if (ctx.io.signal.aborted) return interrupted(command, remote, current)
    if (next.ok) {
      current = next.value
      stale = false
    } else if (exitFor(next.error.code) === EXIT.unavailable) {
      stale = true
    } else {
      throw new CliError(next.error.code, next.error.message ?? 'The server refused the request.')
    }
  }
}

function interrupted(command: string, remote: Remote, o: Operation): CommandResult {
  return operationResult(command, remote, o, {
    status: 'error',
    exitCode: EXIT.interrupted,
    error: {
      code: 'interrupted',
      message: `Stopped watching; operation ${o.id} continues on the server.`,
    },
    next: [`exponetdb operation watch ${o.id}`],
  })
}

/** Whether this invocation waits (the default; `--no-wait` turns it off). */
export function waits(flags: Readonly<Record<string, unknown>>): boolean {
  if (flags['wait'] === true && flags['no-wait'] === true) {
    throw new CliError('usage', '--wait and --no-wait disagree.')
  }
  return flags['no-wait'] !== true
}
