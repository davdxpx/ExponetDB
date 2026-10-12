import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ROUTE_LIST } from '@exponetdb/contracts'
import type { OperationId, Operations, PlanView } from '@exponetdb/sdk'
import { parse as parseYaml } from 'yaml'
import type { CommandResult } from '../output/model.ts'
import { applyPlan, planResult } from './apply.ts'
import { must } from './remote.ts'
import type { CommandInput, CommandSpec, FlagSpec, RunContext } from './types.ts'
import { UsageError } from './usage.ts'
import { WAIT_FLAGS } from './watch.ts'

/**
 * Commands that make a plan through the REST API
 * ([`15-cli/README.md` §6](../../../../exponetdb-docs/15-cli/README.md#6-watching-operations)):
 * the request body comes from typed flags or from `--file` (JSON or YAML),
 * and is checked against the route's request schema before anything is
 * sent. The server plans; `--apply` applies the stored plan and watches it
 * like `plan apply`. A file is data only: it can never name a path, a
 * command or SQL the contract does not have.
 */
type PlanOperation = {
  [K in OperationId]: Operations[K]['response'] extends PlanView ? K : never
}[OperationId]

const ROUTES = new Map(ROUTE_LIST.map((r) => [r.operationId, r]))
const MAX_FILE_BYTES = 256 * 1024

export const FILE_FLAG: FlagSpec = {
  name: 'file',
  type: 'string',
  placeholder: 'path',
  description: 'The request as a JSON or YAML file (checked against the contract).',
}

export const APPLY_FLAG: FlagSpec = {
  name: 'apply',
  type: 'boolean',
  description: 'Apply the plan at once and wait until applied and verified.',
}

/** A request body from a JSON or YAML file the person names (bounded, data only). */
export async function bodyFromFile(ctx: RunContext, path: string): Promise<unknown> {
  const full = resolve(ctx.io.cwd, path)
  const text = await readFile(full, 'utf8').catch(() => {
    throw new UsageError(`The file ${full} cannot be read.`)
  })
  if (Buffer.byteLength(text) > MAX_FILE_BYTES)
    throw new UsageError(`The file ${full} is larger than 256 KiB.`)
  try {
    return /\.ya?ml$/i.test(full) ? parseYaml(text, { maxAliasCount: 0 }) : JSON.parse(text)
  } catch {
    throw new UsageError(
      `The file ${full} is not valid ${/\.ya?ml$/i.test(full) ? 'YAML' : 'JSON'}.`,
    )
  }
}

/** Checks a body against the route's request schema; a mismatch is a usage error naming the fields. */
export function checkedBody(operationId: OperationId, body: unknown): unknown {
  const route = ROUTES.get(operationId)
  if (route?.body === undefined) return body
  const parsed = route.body.safeParse(body)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.length === 0 ? '(body)' : i.path.join('.')}: ${i.message}`)
    throw new UsageError(`The request does not match the contract: ${issues.join('; ')}`)
  }
  return parsed.data
}

export interface PlanCommandSpec<Id extends PlanOperation>
  extends Omit<CommandSpec, 'run' | 'locality' | 'effect' | 'output'> {
  readonly operation: Id
  /** Path parameters from the input. */
  readonly params: (input: CommandInput) => Operations[Id]['params']
  /** The body from typed flags (ignored when `--file` is given), or `{}`. */
  readonly body?: (input: CommandInput) => Record<string, unknown>
  /** Whether `--file` is offered (default when the route has a body with fields). */
  readonly file?: boolean
}

/** A command that plans one change and, with `--apply`, applies and watches it. */
export function planCommand<Id extends PlanOperation>(spec: PlanCommandSpec<Id>): CommandSpec {
  const { operation, params, body, file, ...rest } = spec
  return {
    ...rest,
    flags: [
      ...(rest.flags ?? []),
      ...(file === false ? [] : [FILE_FLAG]),
      APPLY_FLAG,
      ...WAIT_FLAGS,
    ],
    locality: 'remote',
    effect: 'plan',
    output: 'PlanView',
    async run(ctx, input): Promise<CommandResult> {
      const fromFile =
        typeof input.flags['file'] === 'string'
          ? await bodyFromFile(ctx, input.flags['file'])
          : undefined
      const raw = fromFile ?? body?.(input) ?? {}
      const checked = checkedBody(operation, raw)
      const remote = await ctx.remote()
      const plan = must(
        await remote.sdk.call(operation, {
          params: params(input),
          body: checked as Operations[Id]['body'],
        } as never),
      ) as PlanView
      const name = rest.path.join(' ')
      if (input.flags['apply'] !== true || plan.decision === 'deny')
        return planResult(name, remote, plan)
      return applyPlan(ctx, remote, name, plan, input.flags)
    },
  }
}

/** Splits `name=value` pairs of a list flag. */
export function pairs(values: readonly string[] | undefined, flag: string): [string, string][] {
  return (values ?? []).map((v) => {
    const at = v.indexOf('=')
    if (at <= 0) throw new UsageError(`--${flag} takes name=value.`)
    return [v.slice(0, at), v.slice(at + 1)]
  })
}
