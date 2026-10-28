import { resolve } from 'node:path'
import { isNodeCapabilityKey, NODE_CAPABILITY_KEYS } from '@exponetdb/contracts'
import { decodeToken } from '@exponetdb/kernel/node'
import type { NodeStatus, PlanView } from '@exponetdb/sdk'
import { applyPlan, planResult } from '../cli/apply.ts'
import { EXIT } from '../cli/exit.ts'
import { bodyFromFile, checkedBody, pairs, planCommand } from '../cli/planning.ts'
import { arg, flag, listCommand, showCommand } from '../cli/reads.ts'
import { must } from '../cli/remote.ts'
import { stepUpHeader } from '../cli/stepup.ts'
import type { CommandInput, CommandSpec, FlagSpec, Remote, RunContext } from '../cli/types.ts'
import { UsageError } from '../cli/usage.ts'
import { WAIT_FLAGS, watchOperation } from '../cli/watch.ts'
import { CliError } from '../errors.ts'
import { checkNewPrivateFile, createNewPrivateFile } from '../files.ts'
import { ago, dash, header } from '../output/format.ts'
import { type Block, type CommandResult, result } from '../output/model.ts'

/**
 * Nodes ([`07-node-agent/`](../../../../exponetdb-docs/07-node-agent/control-plane.md)):
 * reads with source and time, enrollment from the CLI to an active node,
 * and host plans through the typed capabilities a node offers. No command
 * sends a shell string, a path, a unit name or SQL text: a change is one
 * of the contract's node changes, checked before it is sent; a capability
 * the node does not offer is not offered here either.
 */
const READ = ['nodes.read']
const PLAN = ['nodes.plan']
const MANAGE = ['registry.manage']

const CLUSTER_FLAG: FlagSpec = {
  name: 'cluster',
  type: 'string',
  placeholder: 'cls_…',
  description: 'The cluster on the node.',
  required: true,
}

function capabilityRows(n: Pick<NodeStatus, 'capabilities'>): string[][] {
  return n.capabilities.map((c) => {
    const key = `${c.name}@${c.major}`
    return [c.name, String(c.major), isNodeCapabilityKey(key) ? 'supported' : 'unknown to this CLI']
  })
}

function statusBlocks(n: NodeStatus, now: number): Block[] {
  return [
    {
      kind: 'fields',
      rows: [
        ['Node', n.id],
        ['Server', n.serverId],
        ['State', n.state],
        ['Heartbeat', n.lastHeartbeatAt === null ? null : ago(n.lastHeartbeatAt, now)],
        ['Agent', n.agentVersion],
        ['Protocol', n.protocolMajor === null ? null : String(n.protocolMajor)],
        ['Clock skew', n.clockSkewMs === null ? null : `${n.clockSkewMs} ms`],
        ['Certificate until', n.nodeCertificateExpiresAt],
        ['Observed', `${n.source}, ${ago(n.observedAt, now)}`],
      ],
    },
    {
      kind: 'table',
      columns: [
        { title: 'CLUSTER' },
        { title: 'LOCAL NAME' },
        { title: 'RUNNING' },
        { title: 'RESTART PENDING' },
        { title: 'TLS UNTIL' },
      ],
      rows: n.clusters.map((c) => [
        dash(c.clusterId),
        c.localName,
        c.running ? 'yes' : 'no',
        c.pendingRestart ? 'yes' : 'no',
        dash(c.serverCertificateExpiresAt),
      ]),
      empty: 'No clusters reported.',
    },
  ]
}

/** Refuses locally a change whose capability the node does not offer. */
async function requireCapability(remote: Remote, nodeId: string, name: string): Promise<void> {
  const n = must(await remote.sdk.call('getNode', { params: { nodeId } }))
  const offered = n.capabilities.some(
    (c) => c.name === name && NODE_CAPABILITY_KEYS.includes(`${c.name}@${c.major}` as never),
  )
  if (!offered) {
    throw new CliError(
      'CAPABILITY_UNAVAILABLE',
      `Node ${nodeId} (${n.state}) does not offer ${name} in a version this CLI supports. It offers: ${n.capabilities.map((c) => `${c.name}@${c.major}`).join(', ') || 'nothing'}.`,
    )
  }
}

/**
 * The observation a node plan binds (the server's `BASIS` and `basisArgs`, capability-plans.ts): the
 * capability the plan reads first and its arguments, built from the change. `reusable`: the
 * arguments do not depend on the change, so an observation younger than five minutes is reused;
 * otherwise the plan binds an observation made for exactly these arguments, and a stale or
 * different one is `NODE_OBSERVATION_STALE`, which is how the config and roles plans were a dead
 * end from the CLI (TC-002: `--arg` could not carry the arrays).
 */
const BASIS: Readonly<
  Record<
    string,
    {
      readonly capability: string
      readonly reusable: boolean
      readonly args: (change: Record<string, unknown>) => Record<string, unknown>
    }
  >
> = {
  'postgres.reload': { capability: 'postgres.status@1', reusable: true, args: () => ({}) },
  'postgres.restart': { capability: 'postgres.restart.plan@2', reusable: true, args: () => ({}) },
  'postgres.config.apply': {
    capability: 'postgres.config.plan@2',
    reusable: false,
    args: (change) => ({ changes: change['changes'] ?? [] }),
  },
  'postgres.hba.apply': { capability: 'postgres.hba.inspect@2', reusable: true, args: () => ({}) },
  'postgres.roles.apply': {
    capability: 'postgres.roles.inspect@2',
    reusable: true,
    args: () => ({ expectSettings: [] }),
  },
  'postgres.extensions.apply': {
    capability: 'postgres.extensions.inspect@1',
    reusable: false,
    args: (change) => ({ database: change['database'] ?? null }),
  },
  'postgres.tls.rotate': { capability: 'postgres.tls.inspect@1', reusable: true, args: () => ({}) },
}
const FRESH_OBSERVATION_MS = 5 * 60_000

/** Runs one capability on a node and waits for its signed result. */
async function inspect(
  ctx: RunContext,
  remote: Remote,
  nodeId: string,
  capability: string,
  clusterId: string | undefined,
  args: Record<string, unknown>,
  timeoutMs = 300_000,
): Promise<CommandResult> {
  const body = checkedBody('inspectNode', { capability, clusterId: clusterId ?? null, args })
  const op = must(await remote.sdk.call('inspectNode', { params: { nodeId }, body: body as never }))
  return watchOperation(ctx, remote, 'node inspect', op, timeoutMs)
}

/**
 * Makes the basis observation of a node plan when none usable exists, so `node postgres
 * <config|roles|…>` is one command. Returns the inspection's result when it did not succeed (the
 * plan is then not made), `undefined` when the plan can go on.
 */
async function ensureBasis(
  ctx: RunContext,
  remote: Remote,
  nodeId: string,
  clusterId: string,
  kind: string,
  change: Record<string, unknown>,
): Promise<CommandResult | undefined> {
  const basis = BASIS[kind]
  if (basis === undefined) return undefined
  if (basis.reusable) {
    const seen = must(
      await remote.sdk.call('listNodeObservations', {
        params: { nodeId },
        query: { capability: basis.capability as never, clusterId: clusterId as never },
      }),
    )
    const newest = Math.max(0, ...seen.items.map((o) => Date.parse(o.observedAt)))
    if (ctx.io.now() - newest < FRESH_OBSERVATION_MS) return undefined
  }
  const done = await inspect(ctx, remote, nodeId, basis.capability, clusterId, basis.args(change))
  return done.exitCode === EXIT.ok ? undefined : done
}

/** Plans one node change (a contract `NodeChange`) and, with --apply, applies it. */
function nodeChange(
  path: readonly string[],
  summary: string,
  kind: string,
  extraFlags: readonly FlagSpec[],
  change: (input: CommandInput, ctx: RunContext) => Promise<Record<string, unknown>>,
): CommandSpec {
  return {
    path,
    summary,
    description:
      'Plans the change through the node (node.plan): the server binds it to an observation at most 10 minutes old and to the node’s capability; nothing runs before plan apply. Production needs approval.',
    group: 'node',
    args: [{ name: 'node', description: 'The node id (nod_…).', required: true }],
    flags: [
      CLUSTER_FLAG,
      ...extraFlags,
      {
        name: 'no-inspect',
        type: 'boolean',
        description:
          'Do not inspect the cluster first; plan against an observation you made yourself (at most 10 minutes old).',
      },
      { name: 'apply', type: 'boolean', description: 'Apply the plan at once and wait.' },
      ...WAIT_FLAGS,
    ],
    locality: 'remote',
    effect: 'plan',
    action: 'node.plan',
    scopes: PLAN,
    output: 'PlanView',
    async run(ctx, input): Promise<CommandResult> {
      const nodeId = arg(input, 'node')
      const changed = await change(input, ctx)
      const body = checkedBody('planNodeOperation', {
        clusterId: flag(input, 'cluster'),
        change: { kind, ...changed },
      })
      const remote = await ctx.remote()
      await requireCapability(remote, nodeId, kind)
      if (input.flags['no-inspect'] !== true) {
        const failed = await ensureBasis(
          ctx,
          remote,
          nodeId,
          String(flag(input, 'cluster')),
          kind,
          changed,
        )
        if (failed !== undefined) return failed
      }
      const plan = must(
        await remote.sdk.call('planNodeOperation', { params: { nodeId }, body: body as never }),
      ) as PlanView
      const name = path.join(' ')
      if (input.flags['apply'] !== true || plan.decision === 'deny')
        return planResult(name, remote, plan)
      return applyPlan(ctx, remote, name, plan, input.flags)
    },
  }
}

const fromFile = (what: string) => async (input: CommandInput, ctx: RunContext) => {
  const file = flag(input, 'file')
  if (file === undefined) throw new UsageError(`Give the ${what} as --file change.yaml.`)
  const body = await bodyFromFile(ctx, file)
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new UsageError('The file holds one object (the change without its kind).')
  }
  const { kind: _kind, ...rest } = body as Record<string, unknown>
  return rest
}

const FILE_REQUIRED: FlagSpec = {
  name: 'file',
  type: 'string',
  placeholder: 'path',
  description: 'The change as JSON or YAML (checked against the contract).',
  required: true,
}

/** Public trust metadata of an enrollment token; never its secret. */
function trustOf(token: string) {
  const decoded = decodeToken(token)
  if (!decoded.ok) return undefined
  const t = decoded.token
  return {
    tokenId: t.tokenId,
    installationId: t.installationId,
    serverId: t.serverId,
    gateway: t.gateway,
    gatewayServerName: t.gatewayServerName,
    rootFingerprint: t.rootFingerprint,
    jobKeyFingerprints: t.jobKeys,
  }
}

function instructions(file: string, expiresAt: string | null): string[] {
  return [
    `1. Copy ${file} to the host over a channel you trust (for example scp), into a directory only you can read.${expiresAt === null ? '' : ` It expires at ${expiresAt}.`}`,
    '2. Install the exponetdb-node package and place /etc/exponetdb-node/config.json (see the node runbook).',
    '3. On the host, as yourself (the shell opens the file; the agent user never needs to read it):',
    '     sudo -u exponetdb-node exponetdb-node enroll --config /etc/exponetdb-node/config.json --token-file - < TOKEN_FILE',
    '4. Delete the token file on both machines (shred -u TOKEN_FILE). A lost or expired token needs a new enrollment plan.',
    '5. Watch the node become active: exponetdb node enrollment status <server>',
  ]
}

export const nodeCommands: readonly CommandSpec[] = [
  listCommand({
    path: ['node', 'list'],
    summary: 'List nodes with state, heartbeat and agent version.',
    group: 'node',
    flags: [
      {
        name: 'server',
        type: 'string',
        placeholder: 'srv_…',
        description: 'Only the nodes of this server.',
      },
    ],
    action: 'node.list',
    scopes: READ,
    output: 'NodeList',
    title: 'nodes',
    operation: 'listNodes',
    noun: 'node',
    // The route has no server filter: an unknown server is an error (not an empty list), and the
    // nodes of the others are left out here (TC-031).
    params: async (input, remote) => {
      const serverId = input.flags['server']
      if (typeof serverId === 'string') {
        must(await remote.sdk.call('getServer', { params: { serverId } }))
      }
      return undefined as never
    },
    keep: (n, input) => input.flags['server'] === undefined || n.serverId === input.flags['server'],
    columns: [
      { title: 'NODE' },
      { title: 'SERVER' },
      { title: 'STATE' },
      { title: 'HEARTBEAT' },
      { title: 'AGENT' },
      { title: 'PROTOCOL', align: 'right' },
    ],
    row: (n, now) => [
      n.id,
      n.serverId,
      n.state,
      ago(n.lastHeartbeatAt, now),
      dash(n.agentVersion),
      dash(n.protocolMajor),
    ],
  }),
  ...(['show', 'status'] as const).map((verb) =>
    showCommand({
      path: ['node', verb],
      summary:
        verb === 'show'
          ? 'Show a node: state, heartbeat, certificate, clusters and capabilities.'
          : 'The node’s state with its source and time (pending_binding, active, offline, revoked …).',
      group: 'node',
      args: [{ name: 'node', description: 'The node id (nod_…).', required: true }],
      action: 'node.get',
      scopes: READ,
      output: 'NodeStatus',
      title: 'node',
      operation: 'getNode',
      params: (i) => ({ nodeId: arg(i, 'node') }),
      view: (n, now) =>
        verb === 'status'
          ? statusBlocks(n, now)
          : [
              ...statusBlocks(n, now),
              {
                kind: 'table',
                columns: [
                  { title: 'CAPABILITY' },
                  { title: 'MAJOR', align: 'right' },
                  { title: 'CLI' },
                ],
                rows: capabilityRows(n),
                empty: 'No capabilities reported.',
              },
            ],
    }),
  ),
  showCommand({
    path: ['node', 'capabilities'],
    summary: 'The capabilities a node offers, and whether this CLI supports each version.',
    group: 'node',
    args: [{ name: 'node', description: 'The node id.', required: true }],
    action: 'node.get',
    scopes: READ,
    output: 'NodeStatus',
    title: 'capabilities',
    operation: 'getNode',
    params: (i) => ({ nodeId: arg(i, 'node') }),
    view: (n) => [
      {
        kind: 'table',
        columns: [{ title: 'CAPABILITY' }, { title: 'MAJOR', align: 'right' }, { title: 'CLI' }],
        rows: capabilityRows(n),
        empty:
          n.state === 'active'
            ? 'No capabilities reported.'
            : `No capabilities: the node is ${n.state}.`,
      },
    ],
  }),
  showCommand({
    path: ['node', 'observations'],
    summary: 'The latest node-signed observations of a node.',
    group: 'node',
    args: [{ name: 'node', description: 'The node id.', required: true }],
    flags: [
      {
        name: 'capability',
        type: 'string',
        placeholder: 'name@major',
        description: 'Only this capability.',
      },
      { name: 'cluster', type: 'string', placeholder: 'cls_…', description: 'Only this cluster.' },
    ],
    action: 'node.get',
    scopes: READ,
    output: 'NodeObservationList',
    title: 'observations',
    operation: 'listNodeObservations',
    params: (i) => ({ nodeId: arg(i, 'node') }),
    query: (i) => ({
      ...(flag(i, 'capability') === undefined ? {} : { capability: flag(i, 'capability') }),
      ...(flag(i, 'cluster') === undefined ? {} : { clusterId: flag(i, 'cluster') }),
    }),
    view: (v, now) => [
      {
        kind: 'table',
        columns: [
          { title: 'CAPABILITY' },
          { title: 'CLUSTER' },
          { title: 'OBSERVED' },
          { title: 'OPERATION' },
        ],
        rows: v.items.map((o) => [
          o.capability,
          dash(o.clusterId),
          ago(o.observedAt, now),
          o.operationId,
        ]),
        empty: 'No observations yet. Run: exponetdb node inspect <node> --capability <name@major>',
      },
    ],
  }),
  {
    path: ['node', 'inspect'],
    summary: 'Run one read or plan capability on a node and wait for its signed result.',
    group: 'node',
    args: [{ name: 'node', description: 'The node id.', required: true }],
    flags: [
      {
        name: 'capability',
        type: 'string',
        placeholder: 'name@major',
        description: 'An inspectable capability.',
        required: true,
      },
      {
        name: 'cluster',
        type: 'string',
        placeholder: 'cls_…',
        description: 'The cluster (for postgres capabilities).',
      },
      {
        name: 'arg',
        type: 'list',
        placeholder: 'k=v',
        description: 'Capability arguments (string values).',
      },
      {
        name: 'arg-json',
        type: 'repeat',
        placeholder: 'k=json',
        description: 'Capability arguments as JSON (arrays and objects, for example changes=[…]).',
      },
      WAIT_FLAGS[2] ?? { name: 'timeout-wait', type: 'duration', description: 'Wait.' },
    ],
    locality: 'remote',
    effect: 'plan',
    action: 'node.inspect',
    scopes: PLAN,
    output: 'Operation',
    async run(ctx, input) {
      const nodeId = arg(input, 'node')
      const strings = pairs(input.flags['arg'] as string[] | undefined, 'arg')
      const typed = pairs(input.flags['arg-json'] as string[] | undefined, 'arg-json').map(
        ([name, text]): [string, unknown] => {
          try {
            return [name, JSON.parse(text) as unknown]
          } catch {
            throw new UsageError(`--arg-json ${name}: the value is not valid JSON.`)
          }
        },
      )
      const names = [...strings, ...typed].map(([name]) => name)
      if (new Set(names).size !== names.length) {
        throw new UsageError('Each capability argument is given once (--arg or --arg-json).')
      }
      const remote = await ctx.remote()
      const watched = await inspect(
        ctx,
        remote,
        nodeId,
        String(flag(input, 'capability')),
        flag(input, 'cluster'),
        Object.fromEntries([...strings, ...typed]),
        Number(input.flags['timeout-wait'] ?? 300_000),
      )
      if (watched.exitCode !== EXIT.ok) return watched
      return {
        ...watched,
        next: [`exponetdb node observations ${nodeId} --capability ${flag(input, 'capability')}`],
      }
    },
  },
  nodeChange(
    ['node', 'postgres', 'reload'],
    'Plan a PostgreSQL reload on a node.',
    'postgres.reload',
    [],
    async () => ({}),
  ),
  nodeChange(
    ['node', 'postgres', 'restart'],
    'Plan a PostgreSQL restart on a node (through its helper).',
    'postgres.restart',
    [],
    async () => ({}),
  ),
  nodeChange(
    ['node', 'postgres', 'config'],
    'Plan PostgreSQL parameter changes (managed parameters only; secrets stay references).',
    'postgres.config.apply',
    [
      { name: 'set', type: 'list', placeholder: 'name=value', description: 'Parameters to set.' },
      { name: 'reset', type: 'list', placeholder: 'name', description: 'Parameters to reset.' },
      { name: 'no-reload', type: 'boolean', description: 'Do not reload after applying.' },
    ],
    async (input) => {
      const set = pairs(input.flags['set'] as string[] | undefined, 'set').map(([name, value]) => ({
        name,
        value,
      }))
      const reset = ((input.flags['reset'] as string[] | undefined) ?? []).map((name) => ({
        name,
        value: null,
      }))
      if (set.length + reset.length === 0)
        throw new UsageError('Name at least one --set or --reset.')
      return { changes: [...set, ...reset], reload: input.flags['no-reload'] !== true }
    },
  ),
  nodeChange(
    ['node', 'postgres', 'hba'],
    'Plan the managed pg_hba rules (from --file).',
    'postgres.hba.apply',
    [FILE_REQUIRED],
    fromFile('rules'),
  ),
  nodeChange(
    ['node', 'postgres', 'roles'],
    'Plan role steps (from --file; passwords only as SCRAM verifiers).',
    'postgres.roles.apply',
    [FILE_REQUIRED],
    fromFile('role steps'),
  ),
  nodeChange(
    ['node', 'postgres', 'extensions'],
    'Plan extension steps (from --file).',
    'postgres.extensions.apply',
    [FILE_REQUIRED],
    fromFile('extension steps'),
  ),
  nodeChange(
    ['node', 'postgres', 'tls'],
    'Plan rotating the server TLS certificate (from --file: names and validity).',
    'postgres.tls.rotate',
    [FILE_REQUIRED],
    fromFile('certificate request'),
  ),
  planCommand({
    path: ['node', 'job-keys'],
    summary: 'Plan adding or retiring job-signing keys a node trusts.',
    group: 'node',
    args: [{ name: 'node', description: 'The node id.', required: true }],
    flags: [
      { name: 'add', type: 'list', placeholder: 'key', description: 'Job key ids to add.' },
      { name: 'retire', type: 'list', placeholder: 'key', description: 'Job key ids to retire.' },
    ],
    action: 'node.config.update.plan',
    scopes: MANAGE,
    operation: 'planNodeConfigUpdate',
    params: (i) => ({ nodeId: arg(i, 'node') }),
    body: (i) => ({ addJobKeys: i.flags['add'] ?? [], retireJobKeys: i.flags['retire'] ?? [] }),
    file: false,
  }),
  ...(['revoke', 'decommission'] as const).map((verb) =>
    planCommand({
      path: ['node', verb],
      summary:
        verb === 'revoke'
          ? 'Plan revoking a node (the gateway refuses it at its next request).'
          : 'Plan decommissioning a node.',
      group: 'node',
      args: [{ name: 'node', description: 'The node id.', required: true }],
      action: `node.${verb}.plan`,
      scopes: MANAGE,
      operation: verb === 'revoke' ? 'planNodeRevocation' : 'planNodeDecommissioning',
      params: (i: CommandInput) => ({ nodeId: arg(i, 'node') }),
      file: false,
    }),
  ),
  {
    path: ['node', 'enrollment', 'create'],
    summary:
      'Enroll a node for a server: plan, apply, reveal the token once into a new private file.',
    description:
      'Plans node.enroll for the server, applies it (a fresh confirmation in the browser through a step-up), waits until the token exists, reveals it once and writes it to --token-file (a new 0600 file; nothing is overwritten). The token is never printed. Then follow the instructions on the host.',
    group: 'node',
    args: [{ name: 'server', description: 'The server id (srv_…).', required: true }],
    flags: [
      {
        name: 'token-file',
        type: 'string',
        placeholder: 'path',
        description: 'A new file for the token (0600).',
        required: true,
      },
      ...WAIT_FLAGS.slice(2),
    ],
    locality: 'remote',
    effect: 'mutation',
    action: 'node.enroll',
    scopes: MANAGE,
    output: 'Enrollment',
    async run(ctx, input) {
      const serverId = arg(input, 'server')
      const file = resolve(ctx.io.cwd, String(input.flags['token-file']))
      // The reveal happens once: refuse a file we could not write before anything is planned.
      await checkNewPrivateFile(file)
      const remote = await ctx.remote()
      const plan = must(
        await remote.sdk.call('planNodeEnrollment', { params: { serverId }, body: {} }),
      )
      const content = plan.change?.content as { tokenId?: string } | undefined
      const tokenId = content?.tokenId
      if (plan.decision === 'deny' || tokenId === undefined)
        return planResult('node enrollment create', remote, plan)
      const applied = await applyPlan(ctx, remote, 'node enrollment create', plan, {
        'timeout-wait': input.flags['timeout-wait'],
      })
      if (applied.exitCode !== EXIT.ok) return applied
      let revealed = await remote.sdk.call('revealEnrollmentToken', {
        params: { tokenId },
        body: {},
      })
      if (!revealed.ok && revealed.error.code === 'REAUTH_REQUIRED') {
        const stepUp = await stepUpHeader(ctx, remote, {
          action: 'node.enrollment_token.reveal',
          tokenId,
        })
        revealed = await remote.sdk.call('revealEnrollmentToken', {
          params: { tokenId },
          body: {},
          stepUp,
        })
      }
      const value = must(revealed)
      await createNewPrivateFile(file, `${value.token}\n`)
      const trust = trustOf(value.token)
      return result({
        command: 'node enrollment create',
        planId: plan.id,
        ...(applied.operationId === undefined ? {} : { operationId: applied.operationId }),
        data: {
          serverId,
          tokenId,
          expiresAt: value.expiresAt,
          tokenFile: file,
          trust: trust ?? null,
        },
        blocks: [
          header('node enrollment', remote.context),
          {
            kind: 'fields',
            rows: [
              ['Server', serverId],
              ['Token', `${tokenId} (written to ${file}, 0600; never printed)`],
              ['Expires', value.expiresAt],
              ['Gateway', trust?.gateway ?? null],
              ['TLS name', trust?.gatewayServerName ?? null],
              ['Root fingerprint', trust?.rootFingerprint ?? null],
            ],
          },
          { kind: 'text', lines: instructions(file, value.expiresAt) },
        ],
        next: [`exponetdb node enrollment status ${serverId}`],
      })
    },
  },
  {
    path: ['node', 'enrollment', 'status'],
    summary: 'The nodes of a server and their enrollment state (until active).',
    group: 'node',
    args: [{ name: 'server', description: 'The server id.', required: true }],
    flags: [
      { name: 'wait', type: 'boolean', description: 'Wait until a node of the server is active.' },
      WAIT_FLAGS[2] ?? { name: 'timeout-wait', type: 'duration', description: 'Wait.' },
    ],
    locality: 'remote',
    effect: 'read',
    action: 'node.list',
    scopes: READ,
    output: 'NodeList',
    async run(ctx, input) {
      const serverId = arg(input, 'server')
      const remote = await ctx.remote()
      // An unknown server is not "no node has enrolled yet" (TC-031).
      must(await remote.sdk.call('getServer', { params: { serverId } }))
      const until = ctx.io.now() + Number(input.flags['timeout-wait'] ?? 900_000)
      for (;;) {
        const items = []
        for await (const page of remote.sdk.pages('listNodes', undefined, {})) {
          items.push(...must(page).items.filter((n) => n.serverId === serverId))
        }
        const active = items.some((n) => n.state === 'active')
        const now = ctx.io.now()
        if (input.flags['wait'] !== true || active || now >= until) {
          return result({
            command: 'node enrollment status',
            status: active ? 'ok' : input.flags['wait'] === true ? 'error' : 'ok',
            exitCode: active || input.flags['wait'] !== true ? EXIT.ok : EXIT.unresolved,
            items,
            ...(active || input.flags['wait'] !== true
              ? {}
              : {
                  error: {
                    code: 'WATCH_TIMEOUT',
                    message: 'No node of this server became active within the wait.',
                  },
                }),
            blocks: [
              header(`enrollment · ${serverId}`, remote.context),
              {
                kind: 'table',
                columns: [
                  { title: 'NODE' },
                  { title: 'STATE' },
                  { title: 'HEARTBEAT' },
                  { title: 'AGENT' },
                ],
                rows: items.map((n) => [
                  n.id,
                  n.state,
                  ago(n.lastHeartbeatAt, now),
                  dash(n.agentVersion),
                ]),
                empty: 'No node has enrolled for this server yet.',
              },
            ],
          })
        }
        ctx.progress(
          `waiting: ${items.map((n) => `${n.id} ${n.state}`).join(', ') || 'no node yet'}`,
        )
        try {
          await ctx.io.sleep(5000, ctx.io.signal)
        } catch {
          return result({
            command: 'node enrollment status',
            status: 'error',
            exitCode: EXIT.interrupted,
            items,
            error: { code: 'interrupted', message: 'Stopped waiting.' },
          })
        }
      }
    },
  },
  {
    path: ['node', 'enrollment', 'instructions'],
    summary: 'How to enroll the host with a token file (and the token’s public trust metadata).',
    group: 'node',
    args: [
      {
        name: 'token-file',
        description: 'The token file written by node enrollment create.',
        required: true,
      },
    ],
    locality: 'local',
    effect: 'local',
    output: 'EnrollmentInstructions',
    async run(ctx, input) {
      const file = resolve(ctx.io.cwd, arg(input, 'token-file'))
      const { readPrivateText } = await import('../files.ts')
      const token = (await readPrivateText(file, 4096)).trim()
      const trust = trustOf(token)
      if (trust === undefined) throw new UsageError(`${file} does not hold an enrollment token.`)
      return result({
        command: 'node enrollment instructions',
        data: { tokenFile: file, trust },
        blocks: [
          {
            kind: 'fields',
            rows: [
              ['Token', trust.tokenId],
              ['Server', trust.serverId],
              ['Installation', trust.installationId],
              ['Gateway', trust.gateway],
              ['TLS name', trust.gatewayServerName],
              ['Root fingerprint', trust.rootFingerprint],
            ],
          },
          { kind: 'text', lines: instructions(file, null) },
        ],
      })
    },
  },
]
