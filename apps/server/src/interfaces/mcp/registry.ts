import { type Application, type Caller, idempotencyRequestHash } from '@exponetdb/application'
import type { oauth } from '@exponetdb/auth'
import {
  actionDefinition,
  type ErrorCode,
  isScope,
  MCP_SERVED_TOOL_LIST,
  MCP_TOOLS,
  type McpEra,
  type McpToolDefinition,
  mcpToolDefinition,
  type Scope,
  type ToolContract,
  type ToolError,
  type ToolRateClass,
} from '@exponetdb/contracts'
import type { RequestId } from '@exponetdb/kernel'
import { describeError, type Logger } from '@exponetdb/observability'
import type * as z from 'zod'
import { errorCodeOf } from '../http/request.ts'
import { escapeValue, renderError, renderText, toolError } from './results.ts'

/**
 * The tools of `/mcp` (Wave 7 order §19 to §22; ADR-0027 §3). One host lists
 * and calls them; every tool calls exactly one application use case, the one
 * the REST route of the same action calls (C-9). The host never decides
 * access: the engine does, inside the use case, on every call. Listing is
 * only a convenience for the agent and never a security control.
 */

/** What the edge knows about one request when a tool runs. */
export interface McpCallContext {
  readonly requestId: RequestId
  readonly era: McpEra
  readonly principal: oauth.DelegatedPrincipal
  readonly caller: Caller
  /** The request's declared client capabilities (modern era only; legacy declares them in `initialize`). */
  readonly clientCapabilities: Readonly<Record<string, unknown>> | undefined
  /** Aborted when the client goes away or cancels; a use case may stop reading, never undo an accepted operation. */
  readonly signal: AbortSignal
  /** Ties another cancellation source (the SDK's request signal) to {@link signal}. */
  readonly follow: (signal: AbortSignal) => void
  /**
   * Set by the host when a missing scope must become `403 insufficient_scope`:
   * the scope the action needs, and every scope of the challenge (the held
   * ones plus the needed one, since some clients replace rather than merge).
   */
  challenge?: { readonly required: Scope; readonly scopes: readonly Scope[] }
  /** For the request log: the tool and the outcome code. */
  tool?: string
  outcome?: string
}

export type ToolOutcome =
  | {
      readonly kind: 'result'
      readonly structured: Record<string, unknown>
      readonly text: string
    }
  | { readonly kind: 'error'; readonly error: ToolError; readonly text: string }

export interface ToolHost {
  /** The definitions this request's grant can use, sorted by name. */
  list(ctx: McpCallContext): readonly McpToolDefinition[]
  /** Whether a served tool has this name (anything else is `-32602`). */
  has(name: string): boolean
  rateClass(name: string): ToolRateClass | undefined
  bundleBody(name: string): boolean
  call(ctx: McpCallContext, name: string, args: unknown): Promise<ToolOutcome>
}

type Tool = (typeof MCP_TOOLS)[number]
type ToolName = Tool['name']
type ArgsOf<N extends ToolName> = z.output<Extract<Tool, { name: N }>['input']>
type Binding<N extends ToolName> = (
  app: Application,
  caller: Caller,
  args: ArgsOf<N>,
  ctx: McpCallContext,
) => Promise<unknown>

/** A served tool's idempotency key: REST's key rule, hashed over the tool and its other arguments. */
function idempotency(
  tool: string,
  args: { readonly idempotencyKey?: string | undefined },
): { key: string; requestHash: string } | undefined {
  const { idempotencyKey, ...rest } = args
  if (idempotencyKey === undefined) return undefined
  return {
    key: idempotencyKey,
    requestHash: idempotencyRequestHash(
      'MCP',
      `/mcp/tools/${tool}`,
      JSON.parse(JSON.stringify(rest)),
    ),
  }
}

const page = (a: { readonly limit: number; readonly cursor?: string | undefined }) => ({
  limit: a.limit,
  ...(a.cursor === undefined ? {} : { cursor: a.cursor }),
})

/**
 * The bindings: tool arguments to the same use case call the REST handler
 * of the tool's `restOperationId` makes. The parity suite runs each tool and
 * its REST route on the same fixture and compares the results.
 */
export const BINDINGS: { readonly [N in ToolName]?: Binding<N> } = {
  targets_list: (app, caller, a) =>
    app.registry.targets(
      caller,
      {
        product: a.product,
        project: a.project,
        environment: a.environment,
        tier: a.tier,
        state: a.state,
      },
      page(a),
    ),
  target_get: (app, caller, a) => app.registry.target(caller, a.target),
  target_health: (app, caller, a) => app.registry.targetHealth(caller, a.target),
  schema_inspect: async (app, caller, a) => {
    if (a.object === undefined) {
      return { overview: await app.registry.schemaOverview(caller, a.target), object: null }
    }
    if (a.kind === undefined) {
      throw Object.assign(new Error('kind'), {
        code: 'VALIDATION_FAILED' as const,
        details: {
          errors: [
            {
              path: '/kind',
              code: 'required',
              message: 'Name the kind of the object (table, view, function, …).',
            },
          ],
        },
      })
    }
    return {
      overview: null,
      object: await app.registry.schemaObject(caller, a.target, a.kind, a.object),
    }
  },
  schema_search: (app, caller, a) =>
    app.registry.searchSchema(caller, a.target, { q: a.q, kinds: a.kinds }, page(a)),
  schema_diff: (app, caller, a) =>
    app.registry.schemaDiff(caller, { left: a.left, right: a.right }),
  drift_check: (app, caller, a) => app.registry.runDriftCheck(caller, a.target),
  migration_lint: (app, caller, a) =>
    app.migrations.lint(caller, a.project, { bundles: a.bundles }),
  migration_status: (app, caller, a) => app.migrations.status(caller, a.target),
  migration_plan: (app, caller, a) => {
    if ((a.bundles?.length ?? 0) === 0 && (a.migrationIds?.length ?? 0) === 0) {
      throw Object.assign(new Error('nothing to plan'), {
        code: 'VALIDATION_FAILED' as const,
        details: {
          errors: [
            { path: '', code: 'required', message: 'Name bundles or migrationIds to plan.' },
          ],
        },
      })
    }
    return app.migrations.plan(
      caller,
      a.target,
      {
        ...(a.bundles === undefined ? {} : { bundles: a.bundles }),
        ...(a.migrationIds === undefined ? {} : { migrationIds: a.migrationIds }),
        ...(a.defaults === undefined ? {} : { defaults: a.defaults }),
        ...(a.source === undefined ? {} : { source: a.source }),
        ...(a.lockWaitSeconds === undefined ? {} : { lockWaitSeconds: a.lockWaitSeconds }),
      },
      idempotency('migration_plan', a),
    )
  },
  migration_rollback_plan: (app, caller, a) =>
    app.migrations.planRollback(
      caller,
      a.target,
      a.migrationId,
      idempotency('migration_rollback_plan', a),
    ),
  migration_verify: (app, caller, a) =>
    app.migrations.verify(
      caller,
      a.target,
      a.migrationId,
      { ...(a.revision === undefined ? {} : { revision: a.revision }) },
      idempotency('migration_verify', a),
    ),
  plan_get: (app, caller, a) => app.plan(caller, a.planId),
  plan_apply: (app, caller, a) => app.apply(caller, a.planId),
  plan_withdraw: (app, caller, a) => app.withdraw(caller, a.planId),
  operation_get: (app, caller, a) => app.operation(caller, a.operationId),
  operation_list: (app, caller, a) =>
    app.operations(caller, {
      target: a.target,
      kind: a.kind,
      state: a.state,
      actor: a.actor,
      ...page(a),
    }),
  operation_cancel: (app, caller, a) => app.cancelOperation(caller, a.operationId),
  sessions_list: (app, caller, a) =>
    app.registry.sessions(caller, a.target, {
      state: a.state,
      minAgeSeconds: a.minAgeSeconds,
      application: a.application,
      limit: a.limit,
    }),
  locks_list: (app, caller, a) => app.registry.locks(caller, a.target),
  nodes_list: (app, caller, a) => app.nodes.nodes(caller, page(a)),
  node_status: (app, caller, a) => app.nodes.node(caller, a.node),
  audit_search: (app, caller, a) =>
    app.auditEvents(caller, {
      from: a.from,
      to: a.to,
      target: a.target,
      action: a.action,
      actor: a.actor,
      result: a.result,
      ...page(a),
    }),
}

/** The domain read scopes `read_of_kind` accepts (OD-26). */
const KIND_READ_SCOPES: readonly Scope[] = [
  'targets.read',
  'migrations.read',
  'nodes.read',
  'backups.read',
]

/**
 * Whether a grant could use a tool at all (the listing filter, never a
 * decision): the client kind `mcp` may call the action, and the grant holds
 * a scope the action can need at one of its tiers. The engine decides every
 * call again with RBAC, the subject, the tier and the policy.
 */
export function usable(
  tool: ToolContract,
  delegation: oauth.DelegatedPrincipal['delegation'],
): boolean {
  const action = actionDefinition(tool.action)
  if (!action.clientKinds.includes('mcp') || action.humanOnly) {
    return false
  }
  const held = delegation.scopes
  const tiers = delegation.restrictions.tiers
  const tiered = (permission: string) =>
    tiers.some((t) => {
      const scope = `${permission}:${t}`
      return isScope(scope) && held.has(scope)
    })
  switch (action.scope.kind) {
    case 'fixed':
      return held.has(action.scope.scope)
    case 'tiered':
      return tiered(action.scope.permission)
    case 'of_plan_kind':
      // The plan kinds an MCP client can create are migration kinds.
      return tiered('migrations.apply')
    case 'read_of_kind':
      return KIND_READ_SCOPES.some((s) => held.has(s))
    case 'none':
      return false
  }
}

/** Lines of the text block written from server facts only (ids, states, codes, links). */
function serverLines(tool: ToolContract, value: Record<string, unknown>): string[] {
  const str = (k: string) => (typeof value[k] === 'string' ? (value[k] as string) : undefined)
  const id = str('id')
  if (
    tool.output === MCP_TOOLS.find((t) => t.name === 'operation_get')?.output &&
    id !== undefined
  ) {
    const lines = [
      `Operation ${id}: state ${str('state')}, apply ${str('applyOutcome')}, verification ${str('verificationOutcome')}. Applied is not verified; observe it with operation_get.`,
    ]
    const approval = str('approvalUrl')
    if (str('state') === 'awaiting_approval' && approval !== undefined) {
      lines.push(
        `It waits for a human approval. Give this link to your human; you cannot approve it yourself: ${approval}`,
      )
    }
    return lines
  }
  if (tool.output === MCP_TOOLS.find((t) => t.name === 'plan_get')?.output && id !== undefined) {
    return [
      `Plan ${id} (${str('kind')}): decision ${str('decision')}, state ${str('state')}, plan hash ${str('planHash')}.${str('decision') === 'deny' ? ' The policy denies it; it cannot be applied.' : ' Apply it with plan_apply.'}`,
    ]
  }
  if (Array.isArray(value['items'])) {
    const next = value['nextCursor']
    return [
      `${tool.title}: ${value['items'].length} item(s)${typeof next === 'string' ? '; more with the cursor in nextCursor' : ''}.`,
    ]
  }
  return [`${tool.title}: done.`]
}

export function createToolHost(
  application: Application,
  logger: Logger,
  bindings: typeof BINDINGS = BINDINGS,
): ToolHost {
  const served = new Map<string, ToolContract>(
    MCP_SERVED_TOOL_LIST.filter((t) => Object.hasOwn(bindings, t.name)).map((t) => [t.name, t]),
  )
  const definitions = new Map<string, McpToolDefinition>(
    [...served.values()].map((t) => [t.name, mcpToolDefinition(t)]),
  )
  const sorted = [...served.values()].sort((a, b) => a.name.localeCompare(b.name))

  const refuse = (ctx: McpCallContext, code: ErrorCode, details?: unknown): ToolOutcome => {
    const error = toolError({ code, requestId: ctx.requestId, details })
    ctx.outcome = error.code
    return { kind: 'error', error, text: renderError(error) }
  }

  return {
    list: (ctx) =>
      sorted
        .filter((t) => usable(t, ctx.principal.delegation))
        .map((t) => definitions.get(t.name))
        .filter((d): d is McpToolDefinition => d !== undefined),
    has: (name) => served.has(name),
    rateClass: (name) => served.get(name)?.rateClass,
    bundleBody: (name) => served.get(name)?.bundleBody === true,
    async call(ctx, name, args) {
      const tool = served.get(name)
      const binding = bindings[name as ToolName] as Binding<ToolName> | undefined
      if (tool === undefined || binding === undefined) {
        return refuse(ctx, 'INTERNAL')
      }
      ctx.tool = name
      const parsed = tool.input.safeParse(args ?? {})
      if (!parsed.success) {
        return refuse(ctx, 'VALIDATION_FAILED', {
          errors: parsed.error.issues.slice(0, 50).map((issue) => ({
            path: `/${issue.path.map(String).join('/')}`,
            code: issue.code.replace(/[^a-z0-9_]/g, '_').slice(0, 64) || 'invalid',
            message: issue.message.slice(0, 512),
          })),
        })
      }
      let value: unknown
      try {
        value = await binding(application, ctx.caller, parsed.data as ArgsOf<ToolName>, ctx)
      } catch (error) {
        const code = errorCodeOf(error)
        if (code === 'INTERNAL') {
          logger.error('mcp.tool_failed', { ...describeError(error), tool: name })
        }
        if (code === 'INSUFFICIENT_SCOPE') {
          const details =
            error instanceof Error && 'details' in error
              ? (error as { details?: unknown }).details
              : undefined
          const required =
            typeof details === 'object' && details !== null
              ? (details as Record<string, unknown>)['requiredScope']
              : undefined
          if (typeof required === 'string' && isScope(required)) {
            const scopes = new Set<Scope>(ctx.principal.delegation.scopes).add(required)
            ctx.challenge = { required, scopes: [...scopes].sort() }
          }
        }
        const details =
          error instanceof Error && 'details' in error
            ? (error as { details?: unknown }).details
            : undefined
        return refuse(ctx, code, details)
      }
      const output = tool.output.safeParse(value)
      if (!output.success) {
        logger.error('mcp.output_contract_violation', { tool: name })
        return refuse(ctx, 'INTERNAL')
      }
      const structured = escapeValue(output.data) as Record<string, unknown>
      ctx.outcome = 'ok'
      return {
        kind: 'result',
        structured,
        text: renderText(serverLines(tool, structured), structured),
      }
    },
  }
}
