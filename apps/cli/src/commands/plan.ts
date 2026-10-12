import { resolve } from 'node:path'
import type { Operation } from '@exponetdb/sdk'
import { applyPlan, planResult } from '../cli/apply.ts'
import { EXIT } from '../cli/exit.ts'
import { collect, LIST_FLAGS, listingFailure } from '../cli/lists.ts'
import { must } from '../cli/remote.ts'
import type { CommandSpec } from '../cli/types.ts'
import { operationResult, WAIT_FLAGS, waits, watchOperation } from '../cli/watch.ts'
import { createNewPrivateFile } from '../files.ts'
import { ago, countLine, header } from '../output/format.ts'
import { result } from '../output/model.ts'
import { planBlocks } from '../output/views.ts'

/**
 * Plans, operations and approvals ([`15-cli/README.md` §6](../../../../exponetdb-docs/15-cli/README.md#6-watching-operations)).
 * `plan apply` applies the stored plan: the target, tier and content are
 * the plan's, never the current defaults. Approvals happen in the Web App
 * (ADR-0026 §6): the CLI opens the bound approval page and watches.
 */
const operationRows = (items: readonly Operation[], now: number) =>
  items.map((o) => [
    o.id,
    o.kind,
    o.state,
    o.applyOutcome,
    o.verificationOutcome,
    o.subject.targetPath ?? o.subject.targetId ?? '-',
    ago(o.updatedAt, now),
  ])

const OPERATION_COLUMNS = [
  { title: 'OPERATION' },
  { title: 'KIND' },
  { title: 'STATE' },
  { title: 'APPLY' },
  { title: 'VERIFY' },
  { title: 'TARGET', flexible: true },
  { title: 'UPDATED' },
] as const

export const planCommands: readonly CommandSpec[] = [
  {
    path: ['plan', 'show'],
    summary: 'Show a plan: subject, decision, requirements, content and analysis.',
    group: 'plan',
    args: [{ name: 'plan', description: 'The plan id (pln_…).', required: true }],
    locality: 'remote',
    effect: 'read',
    action: 'plan.get',
    scopes: ['targets.read'],
    output: 'PlanView',
    examples: ['exponetdb plan show pln_01…'],
    async run(ctx, input) {
      const remote = await ctx.remote()
      const p = must(
        await remote.sdk.call('getPlan', { params: { planId: String(input.args['plan']) } }),
      )
      return planResult('plan show', remote, p)
    },
  },
  {
    path: ['plan', 'list'],
    summary: 'List plans you may read, newest first (filter by target, kind, state).',
    group: 'plan',
    flags: [
      {
        name: 'target',
        type: 'string',
        placeholder: 'target',
        description: 'A target id or path.',
      },
      {
        name: 'kind',
        type: 'string',
        placeholder: 'kind',
        description: 'A plan kind, e.g. migration.apply.',
      },
      {
        name: 'state',
        type: 'enum',
        values: ['active', 'consumed', 'expired', 'invalidated', 'denied', 'withdrawn'],
        description: 'Only plans in this state.',
      },
      { name: 'mine', type: 'boolean', description: 'Only plans you created.' },
      ...LIST_FLAGS,
    ],
    locality: 'remote',
    effect: 'read',
    action: 'plan.list',
    scopes: ['targets.read'],
    output: 'PlanList',
    async run(ctx, input) {
      const remote = await ctx.remote()
      const f = input.flags
      const listing = await collect(
        remote,
        'listPlans',
        undefined,
        {
          ...(f['target'] === undefined ? {} : { target: String(f['target']) }),
          ...(f['kind'] === undefined ? {} : { kind: String(f['kind']) }),
          ...(f['state'] === undefined ? {} : { state: String(f['state']) }),
          ...(f['mine'] === true ? { actor: 'self' } : {}),
        } as never,
        f,
      )
      const now = ctx.io.now()
      const blocks = [
        header('plans', remote.context),
        {
          kind: 'table' as const,
          columns: [
            { title: 'PLAN' },
            { title: 'KIND' },
            { title: 'STATE' },
            { title: 'DECISION' },
            { title: 'TARGET', flexible: true },
            { title: 'TIER' },
            { title: 'CREATED' },
          ],
          rows: listing.items.map((p) => [
            p.id,
            p.kind,
            p.state,
            p.decision,
            p.subject.targetPath ??
              p.subject.targetId ??
              p.subject.clusterId ??
              p.subject.nodeId ??
              '-',
            p.subject.tier ?? '-',
            ago(p.createdAt, now),
          ]),
          empty: 'No plans you may read match.',
        },
        countLine(listing.items.length, 'plan', listing.partial),
      ]
      return (
        listingFailure('plan list', listing, { blocks }) ??
        result({
          command: 'plan list',
          items: listing.items,
          blocks,
          next:
            listing.nextCursor === null
              ? []
              : [`exponetdb plan list --cursor ${listing.nextCursor}`],
        })
      )
    },
  },
  {
    path: ['plan', 'export'],
    summary: 'Write a plan as JSON (to stdout, or to a new private file with --file).',
    description:
      'The plan view as the server stores and shows it: subject, bindings, content and analysis by digest. A plan carries no SQL text and no secret. --file never overwrites an existing file.',
    group: 'plan',
    args: [{ name: 'plan', description: 'The plan id (pln_…).', required: true }],
    flags: [
      {
        name: 'file',
        type: 'string',
        placeholder: 'path',
        description: 'A new file to write (0600).',
      },
    ],
    locality: 'remote',
    effect: 'read',
    action: 'plan.get',
    scopes: ['targets.read'],
    output: 'PlanView',
    async run(ctx, input) {
      const remote = await ctx.remote()
      const p = must(
        await remote.sdk.call('getPlan', { params: { planId: String(input.args['plan']) } }),
      )
      const file = input.flags['file']
      if (file === undefined) {
        if (ctx.format === 'table') {
          ctx.io.stdout(`${JSON.stringify(p, null, 2)}\n`)
          return result({ command: 'plan export', planId: p.id })
        }
        return result({ command: 'plan export', planId: p.id, data: p })
      }
      const path = resolve(ctx.io.cwd, String(file))
      await createNewPrivateFile(path, `${JSON.stringify(p, null, 2)}\n`)
      return result({
        command: 'plan export',
        planId: p.id,
        data: { planId: p.id, file: path },
        blocks: [{ kind: 'text', lines: [`Plan ${p.id} written to ${path}.`] }],
      })
    },
  },
  {
    path: ['plan', 'apply'],
    summary: 'Apply a stored plan and wait until it is applied and verified.',
    description:
      'Applies exactly the stored plan (its target, tier, content and bindings); the server re-checks every binding and refuses a stale plan. Waits by default; exit 0 only when the change is applied and verified. A production plan asks for confirmation on a terminal (or --yes, which never replaces an approval or a re-authentication).',
    group: 'plan',
    args: [{ name: 'plan', description: 'The plan id (pln_…).', required: true }],
    flags: [
      ...WAIT_FLAGS,
      {
        name: 'step-up',
        type: 'string',
        placeholder: 'stu_…',
        description: 'A step-up already confirmed for this plan (exponetdb auth reauth --plan).',
      },
    ],
    locality: 'remote',
    effect: 'mutation',
    action: 'plan.apply',
    output: 'Operation',
    examples: [
      'exponetdb plan apply pln_01… --wait',
      'exponetdb plan apply pln_01… --no-wait --json',
    ],
    async run(ctx, input) {
      const remote = await ctx.remote()
      const p = must(
        await remote.sdk.call('getPlan', { params: { planId: String(input.args['plan']) } }),
      )
      if (p.state !== 'active') {
        const code =
          p.state === 'expired'
            ? 'PLAN_EXPIRED'
            : p.state === 'consumed'
              ? 'PLAN_ALREADY_USED'
              : 'PLAN_STALE'
        return result({
          command: 'plan apply',
          status: 'error',
          exitCode: EXIT.failure,
          planId: p.id,
          error: { code, message: `The plan is ${p.state}; it cannot be applied. Plan again.` },
          next: p.state === 'consumed' ? ['exponetdb operation list --mine'] : [],
        })
      }
      if (p.decision === 'deny') return planResult('plan apply', remote, p)
      return applyPlan(ctx, remote, 'plan apply', p, input.flags)
    },
  },
  {
    path: ['plan', 'withdraw'],
    summary: 'Withdraw your own active plan (it can no longer be applied).',
    group: 'plan',
    args: [{ name: 'plan', description: 'The plan id (pln_…).', required: true }],
    locality: 'remote',
    effect: 'mutation',
    action: 'plan.withdraw',
    output: 'PlanView',
    async run(ctx, input) {
      const remote = await ctx.remote()
      const p = must(
        await remote.sdk.call('withdrawPlan', {
          params: { planId: String(input.args['plan']) },
          body: {},
        }),
      )
      return planResult('plan withdraw', remote, p)
    },
  },
  {
    path: ['operation', 'list'],
    summary: 'List operations you may read, newest first.',
    group: 'operation',
    flags: [
      {
        name: 'target',
        type: 'string',
        placeholder: 'target',
        description: 'A target id or path.',
      },
      {
        name: 'kind',
        type: 'string',
        placeholder: 'kind',
        description: 'An operation kind, e.g. migration.apply.',
      },
      {
        name: 'state',
        type: 'enum',
        values: [
          'awaiting_approval',
          'queued',
          'running',
          'verifying',
          'needs_reconciliation',
          'needs_attention',
          'succeeded',
          'failed',
          'verification_failed',
          'canceled',
        ],
        description: 'Only operations in this state.',
      },
      { name: 'mine', type: 'boolean', description: 'Only operations you started.' },
      ...LIST_FLAGS,
    ],
    locality: 'remote',
    effect: 'read',
    action: 'operation.list',
    scopes: ['targets.read'],
    output: 'OperationList',
    async run(ctx, input) {
      const remote = await ctx.remote()
      const f = input.flags
      const listing = await collect(
        remote,
        'listOperations',
        undefined,
        {
          ...(f['target'] === undefined ? {} : { target: String(f['target']) }),
          ...(f['kind'] === undefined ? {} : { kind: String(f['kind']) }),
          ...(f['state'] === undefined ? {} : { state: String(f['state']) }),
          ...(f['mine'] === true ? { actor: 'self' } : {}),
        } as never,
        f,
      )
      const blocks = [
        header('operations', remote.context),
        {
          kind: 'table' as const,
          columns: OPERATION_COLUMNS,
          rows: operationRows(listing.items, ctx.io.now()),
          empty: 'No operations you may read match.',
        },
        countLine(listing.items.length, 'operation', listing.partial),
      ]
      return (
        listingFailure('operation list', listing, { blocks }) ??
        result({
          command: 'operation list',
          items: listing.items,
          blocks,
          next:
            listing.nextCursor === null
              ? []
              : [`exponetdb operation list --cursor ${listing.nextCursor}`],
        })
      )
    },
  },
  {
    path: ['operation', 'show'],
    summary: 'Show an operation: state, apply and verification outcomes, steps and migrations.',
    group: 'operation',
    args: [{ name: 'operation', description: 'The operation id (op_…).', required: true }],
    locality: 'remote',
    effect: 'read',
    action: 'operation.get',
    scopes: ['targets.read'],
    output: 'Operation',
    async run(ctx, input) {
      const remote = await ctx.remote()
      const o = must(
        await remote.sdk.call('getOperation', {
          params: { operationId: String(input.args['operation']) },
        }),
      )
      // A read reports the state as it is: exit 0 for a successful read of any state.
      return operationResult('operation show', remote, o, {
        status: 'ok',
        exitCode: EXIT.ok,
        error: null,
      })
    },
  },
  {
    path: ['operation', 'watch'],
    summary: 'Watch an operation until it is final (exit 0 only when applied and verified).',
    description:
      'Polls the operation with bounded backoff and reports each change on stderr (NDJSON: progress records). Ctrl-C stops watching; the operation continues on the server.',
    group: 'operation',
    args: [{ name: 'operation', description: 'The operation id (op_…).', required: true }],
    flags: [WAIT_FLAGS[2] ?? { name: 'timeout-wait', type: 'duration', description: 'Wait.' }],
    locality: 'remote',
    effect: 'read',
    action: 'operation.get',
    scopes: ['targets.read'],
    output: 'Operation',
    async run(ctx, input) {
      const remote = await ctx.remote()
      const o = must(
        await remote.sdk.call('getOperation', {
          params: { operationId: String(input.args['operation']) },
        }),
      )
      return watchOperation(
        ctx,
        remote,
        'operation watch',
        o,
        Number(input.flags['timeout-wait'] ?? 900_000),
      )
    },
  },
  {
    path: ['operation', 'cancel'],
    summary: 'Cancel an operation that has not started (awaiting approval or queued).',
    description:
      'A separate, authorized request: only the person or client that applied the plan may cancel, and only before the operation runs. A running operation is never interrupted from the CLI.',
    group: 'operation',
    args: [{ name: 'operation', description: 'The operation id (op_…).', required: true }],
    locality: 'remote',
    effect: 'mutation',
    action: 'operation.cancel',
    output: 'Operation',
    async run(ctx, input) {
      const remote = await ctx.remote()
      const o = must(
        await remote.sdk.call('cancelOperation', {
          params: { operationId: String(input.args['operation']) },
          body: {},
        }),
      )
      return operationResult('operation cancel', remote, o, {
        status: 'ok',
        exitCode: EXIT.ok,
        error: null,
      })
    },
  },
  {
    path: ['operation', 'retry-verification'],
    summary: 'Verify again an operation that needs attention after an applied change.',
    description:
      'For an operation in needs_attention whose change was applied but whose verification errored or never finished (a timeout, the target unreachable). The change is never run again: the worker re-runs the read-only verification. Waits by default; exit 0 only when the verification passed.',
    group: 'operation',
    args: [{ name: 'operation', description: 'The operation id (op_…).', required: true }],
    flags: WAIT_FLAGS,
    locality: 'remote',
    effect: 'mutation',
    action: 'operation.retry_verification',
    output: 'Operation',
    examples: ['exponetdb operation retry-verification op_01… --wait'],
    async run(ctx, input) {
      const remote = await ctx.remote()
      const o = must(
        await remote.sdk.call('retryOperationVerification', {
          params: { operationId: String(input.args['operation']) },
          body: {},
        }),
      )
      if (!waits(input.flags)) {
        return watchOperation(ctx, remote, 'operation retry-verification', o, 0)
      }
      return watchOperation(
        ctx,
        remote,
        'operation retry-verification',
        o,
        Number(input.flags['timeout-wait'] ?? 900_000),
      )
    },
  },
  {
    path: ['approval', 'list'],
    summary: 'List operations awaiting approval that you may read.',
    description:
      'Approvals are decided in the Web App (re-authentication, the exact plan hash). This lists what waits; `approval open` takes you to the bound approval page.',
    group: 'approval',
    flags: LIST_FLAGS,
    locality: 'remote',
    effect: 'read',
    action: 'operation.list',
    scopes: ['targets.read'],
    output: 'OperationList',
    async run(ctx, input) {
      const remote = await ctx.remote()
      const listing = await collect(
        remote,
        'listOperations',
        undefined,
        { state: 'awaiting_approval' } as never,
        input.flags,
      )
      const blocks = [
        header('approvals', remote.context),
        {
          kind: 'table' as const,
          columns: OPERATION_COLUMNS,
          rows: operationRows(listing.items, ctx.io.now()),
          empty: 'Nothing you may read awaits approval.',
        },
        countLine(listing.items.length, 'operation', listing.partial),
      ]
      return (
        listingFailure('approval list', listing, { blocks }) ??
        result({ command: 'approval list', items: listing.items, blocks })
      )
    },
  },
  {
    path: ['approval', 'show'],
    summary: 'Show what an approval decides: the operation, its plan and the plan hash.',
    group: 'approval',
    args: [{ name: 'operation', description: 'The operation id (op_…).', required: true }],
    locality: 'remote',
    effect: 'read',
    action: 'plan.get',
    scopes: ['targets.read'],
    output: 'ApprovalView',
    async run(ctx, input) {
      const remote = await ctx.remote()
      const o = must(
        await remote.sdk.call('getOperation', {
          params: { operationId: String(input.args['operation']) },
        }),
      )
      const p =
        o.planId === null
          ? undefined
          : must(await remote.sdk.call('getPlan', { params: { planId: o.planId } }))
      return result({
        command: 'approval show',
        operationId: o.id,
        ...(p === undefined ? {} : { planId: p.id }),
        data: { operation: o, plan: p ?? null },
        blocks: [
          header(`Approval · ${o.id}`, remote.context),
          {
            kind: 'fields',
            rows: [
              ['State', o.state],
              ['Kind', o.kind],
              ['Plan', o.planId],
              ['Plan hash', p?.planHash ?? null],
              [
                'Approvals',
                p === undefined ? null : `${p.approvals.given} of ${p.approvals.required}`,
              ],
              ['Approve at', o.approvalUrl],
            ],
          },
          ...(p === undefined ? [] : planBlocks(p)),
        ],
        next: o.state === 'awaiting_approval' ? [`exponetdb approval open ${o.id}`] : [],
      })
    },
  },
  ...(['open', 'approve', 'reject'] as const).map(
    (verb): CommandSpec => ({
      path: ['approval', verb],
      summary:
        verb === 'open'
          ? 'Open the bound approval page in the browser.'
          : `Open the approval page to ${verb} (re-authentication there), then wait for the decision.`,
      description:
        'There is no CLI approval endpoint (ADR-0026 §6): the decision is taken in the Web App with a fresh re-authentication and the exact plan hash. The CLI opens that page and, unless --no-wait, watches the operation until the decision is recorded.',
      group: 'approval',
      args: [{ name: 'operation', description: 'The operation id (op_…).', required: true }],
      flags: verb === 'open' ? [] : WAIT_FLAGS,
      locality: 'remote',
      effect: 'read',
      action: 'operation.get',
      scopes: ['targets.read'],
      output: 'Operation',
      async run(ctx, input) {
        const remote = await ctx.remote()
        const o = must(
          await remote.sdk.call('getOperation', {
            params: { operationId: String(input.args['operation']) },
          }),
        )
        if (o.state !== 'awaiting_approval' || o.approvalUrl === null) {
          return operationResult(`approval ${verb}`, remote, o, {
            status: 'error',
            exitCode: EXIT.failure,
            error: {
              code: 'APPROVAL_NOT_PENDING',
              message: `The operation is ${o.state.replaceAll('_', ' ')}; nothing awaits approval.`,
            },
          })
        }
        ctx.io.stderr(`Approve or reject at: ${o.approvalUrl}\n`)
        if (!ctx.global.noInput) ctx.io.openBrowser(o.approvalUrl)
        if (verb === 'open' || !waits(input.flags) || ctx.global.noInput) {
          return operationResult(`approval ${verb}`, remote, o, {
            status: 'requires_action',
            exitCode: EXIT.ok,
          })
        }
        // Wait for the decision: the operation leaves awaiting_approval (approved) or ends canceled (rejected).
        const until = ctx.io.now() + Number(input.flags['timeout-wait'] ?? 900_000)
        let current: Operation = o
        while (current.state === 'awaiting_approval' && ctx.io.now() < until) {
          try {
            await ctx.io.sleep(2000, ctx.io.signal)
          } catch {
            return operationResult(`approval ${verb}`, remote, current, {
              status: 'error',
              exitCode: EXIT.interrupted,
              error: {
                code: 'interrupted',
                message: 'Stopped waiting; the approval page stays valid.',
              },
            })
          }
          const next = await remote.sdk.call('getOperation', { params: { operationId: o.id } })
          if (next.ok) current = next.value
        }
        if (current.state === 'awaiting_approval') {
          return operationResult(`approval ${verb}`, remote, current, {
            status: 'error',
            exitCode: EXIT.unresolved,
            error: { code: 'WATCH_TIMEOUT', message: 'No decision was recorded within the wait.' },
          })
        }
        const rejected = current.state === 'canceled'
        return operationResult(`approval ${verb}`, remote, current, {
          status: 'ok',
          exitCode: EXIT.ok,
          error: null,
          blocks: [
            header(`Approval · ${current.id}`, remote.context),
            {
              kind: 'status',
              word: rejected ? 'Rejected' : 'Approved',
              tone: rejected ? 'warn' : 'ok',
              text: `operation is ${current.state.replaceAll('_', ' ')}`,
            },
          ],
          next: rejected ? [] : [`exponetdb operation watch ${current.id}`],
        })
      },
    }),
  ),
]
