import { oauth } from '@exponetdb/auth'
import type { Scope } from '@exponetdb/contracts'
import { type GrantId, newUlid } from '@exponetdb/kernel'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bundle, DEFAULTS, McpCaller, type McpWorld, mcpWorld } from './support/mcp-int-world.ts'
import { ORIGIN } from './support/node-world.ts'

/**
 * Plans, applies and operations through `/mcp` over the real program
 * (Wave 7 Phase 6): the agent proposes, the engine and the policy decide,
 * a person approves production. Applied is not verified; a failure is
 * never repeated; a stale plan says what changed. Real PostgreSQL 17.
 */
const READ: Scope[] = ['targets.read', 'schema.read', 'diagnostics.read', 'migrations.read']

let w: McpWorld
let clientId: string
/** Nonprod agent: plans and applies on staging. */
let agent: McpCaller
/** An agent whose grant also covers production (applies still need a person). */
let prodAgent: McpCaller
/** The same person reading the audit through MCP. */
let auditor: McpCaller
/** The first staging operation (by `agent`). */
let firstOperation: string

const ADD_NOTES = 'ALTER TABLE public.accounts ADD COLUMN notes text;\n'
const NOTES_VERIFY =
  "-- check: notes exist\nSELECT count(*) = 1 AS ok FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'notes';\n"

function notesBundle(id: string, column = 'notes') {
  return bundle({
    id,
    name: `add-${column.replaceAll('_', '-')}`,
    up: ADD_NOTES.replaceAll('notes', column),
    verify: NOTES_VERIFY.replaceAll('notes', column),
  })
}

beforeAll(async () => {
  w = await mcpWorld('exdb_it_mcp_plans')
  clientId = await w.mcpClient('Agent Two')
  agent = new McpCaller(
    w.app,
    (
      await w.mcpToken(
        clientId,
        [...READ, 'migrations.plan', 'migrations.apply:nonprod'],
        ['nonprod'],
      )
    ).access_token,
  )
  prodAgent = new McpCaller(
    w.app,
    (
      await w.mcpToken(
        clientId,
        [...READ, 'migrations.plan', 'migrations.apply:nonprod', 'migrations.apply:prod'],
        ['nonprod', 'prod'],
      )
    ).access_token,
  )
  auditor = new McpCaller(
    w.app,
    (await w.mcpToken(clientId, ['targets.read', 'audit.read'], ['nonprod', 'prod'])).access_token,
  )
}, 300_000)

afterAll(async () => {
  await w?.stop()
})

/** Lets the worker run, then reads the operation through MCP. */
async function settle(caller: McpCaller, operationId: string) {
  await w.drive()
  return (await caller.call('operation_get', { operationId })).structuredContent ?? {}
}

describe('plan tools over the real program', () => {
  const first = newUlid(Date.now())

  it('plans, applies and verifies on staging; a retry gets the same plan and the same operation', async () => {
    const planned = await agent.call('migration_plan', {
      target: w.ids.stagingTarget,
      bundles: [notesBundle(first)],
      defaults: DEFAULTS,
      idempotencyKey: 'notes-staging-1',
    })
    expect(planned.isError, planned.content[0]?.text.slice(0, 400)).toBeUndefined()
    const plan = planned.structuredContent ?? {}
    expect(plan).toMatchObject({ decision: 'allow', planHash: expect.any(String) })
    expect(planned.content[0]?.text).toMatch(
      new RegExp(
        `^Plan ${plan['id']} \\(migration\\.apply\\): decision allow, state \\w+, plan hash `,
      ),
    )
    // The same key and the same request: the same plan; another request: refused.
    const again = await agent.call('migration_plan', {
      target: w.ids.stagingTarget,
      bundles: [notesBundle(first)],
      defaults: DEFAULTS,
      idempotencyKey: 'notes-staging-1',
    })
    expect(again.structuredContent?.['id']).toBe(plan['id'])
    const reused = await agent.call('migration_plan', {
      target: w.ids.stagingTarget,
      bundles: [notesBundle(first)],
      defaults: DEFAULTS,
      lockWaitSeconds: 30,
      idempotencyKey: 'notes-staging-1',
    })
    expect(reused.content[0]?.text).toMatch(/^Refused: IDEMPOTENCY_KEY_REUSED\./)

    const applied = await agent.call('plan_apply', { planId: plan['id'] })
    const operation = applied.structuredContent ?? {}
    expect(operation).toMatchObject({ planId: plan['id'], applyOutcome: 'not_started' })
    expect(applied.content[0]?.text).toMatch(
      /Applied is not verified; observe it with operation_get\./,
    )
    const retried = await agent.call('plan_apply', { planId: plan['id'] })
    expect(retried.structuredContent?.['id']).toBe(operation['id'])
    firstOperation = operation['id']

    const done = await settle(agent, operation['id'])
    expect(done).toMatchObject({
      state: 'succeeded',
      applyOutcome: 'applied',
      verificationOutcome: 'passed',
    })
    const status = await agent.call('migration_status', { target: w.ids.stagingTarget })
    expect(status.structuredContent?.['applied']).toEqual(
      expect.arrayContaining([expect.objectContaining({ migrationId: first })]),
    )
    // A wait on a final operation answers at once.
    const started = Date.now()
    const final = await agent.call('operation_get', {
      operationId: operation['id'],
      waitSeconds: 20,
    })
    expect(final.structuredContent?.['state']).toBe('succeeded')
    expect(Date.now() - started).toBeLessThan(5000)

    // Verification again, through its own operation.
    const verify = await agent.call('migration_verify', {
      target: w.ids.stagingTarget,
      migrationId: first,
    })
    expect(verify.isError, verify.content[0]?.text.slice(0, 300)).toBeUndefined()
  })

  it('production by an agent waits for a person, with the approval link in the result', async () => {
    const planned = await prodAgent.call('migration_plan', {
      target: w.ids.productionTarget,
      migrationIds: [first],
      defaults: DEFAULTS,
    })
    expect(planned.isError, planned.content[0]?.text.slice(0, 400)).toBeUndefined()
    const plan = planned.structuredContent ?? {}
    expect(plan).toMatchObject({ decision: 'require', approvals: { required: 1, given: 0 } })
    // Attribution: the person and the client.
    expect(plan).toMatchObject({
      actor: { kind: 'human', via: 'mcp' },
      clientId: expect.stringMatching(/^cli_/),
    })
    const clients = await w.owner.browser.call('GET', '/api/v1/oauth-clients')
    const registered = clients.body.items.find((c: { clientId: string }) => c.clientId === clientId)
    expect(registered.id).toBe(plan['clientId'])

    const applied = await prodAgent.call('plan_apply', { planId: plan['id'] })
    const operation = applied.structuredContent ?? {}
    expect(operation).toMatchObject({
      state: 'awaiting_approval',
      approvalUrl: `${ORIGIN}/approvals#operation=${operation['id']}`,
    })
    const text = applied.content[0]?.text ?? ''
    expect(text).toContain(
      `It waits for a human approval. Give this link to your human; you cannot approve it yourself: ${ORIGIN}/approvals#operation=${operation['id']}`,
    )
    // Waiting while nobody approves: answers after the wait with the same state.
    const waited = await prodAgent.call('operation_get', {
      operationId: operation['id'],
      waitSeconds: 1,
    })
    expect(waited.structuredContent?.['state']).toBe('awaiting_approval')

    // What the person reviews: server facts, the client's own name, the stored up.sql verbatim.
    const queue = await w.owner.browser.call('GET', '/api/v1/approvals')
    const item = queue.body.items.find(
      (i: { operationId: string }) => i.operationId === operation['id'],
    )
    expect(item.review).toMatchObject({
      clientName: 'Agent Two',
      plan: {
        id: plan['id'],
        planHash: plan['planHash'],
        subject: { targetPath: `${w.ids.slug}/platform/production`, tier: 'prod' },
        actor: { kind: 'human', via: 'mcp' },
        decision: 'require',
      },
      sources: [
        { migrationId: first, revision: 1, file: 'up.sql', text: ADD_NOTES, truncated: false },
      ],
    })
    expect(item.review.plan.change.analysis.perMigration[0].statements[0]).toMatchObject({
      line: 1,
      kind: expect.any(String),
    })
    expect(item.change).toBeDefined()

    // The person approves in the Web App (here: its API); the worker applies.
    await w.owner.reauth()
    const approved = await w.owner.browser.call(
      'POST',
      `/api/v1/approvals/${operation['id']}/approve`,
      { planHash: plan['planHash'], acknowledgeSelfApproval: true },
    )
    expect(approved.status, approved.text).toBe(200)
    expect(await settle(prodAgent, operation['id'])).toMatchObject({
      state: 'succeeded',
      verificationOutcome: 'passed',
    })
  })

  it('shows the approval link as a URL elicitation to a client that declared it; the retry only reads', async () => {
    const migration = newUlid(Date.now())
    const staged = await agent.call('migration_plan', {
      target: w.ids.stagingTarget,
      bundles: [notesBundle(migration, 'elicited')],
      defaults: DEFAULTS,
    })
    const stagedOp = await agent.call('plan_apply', { planId: staged.structuredContent?.['id'] })
    await settle(agent, stagedOp.structuredContent?.['id'])
    const eliciting = new McpCaller(w.app, prodAgent.token, 'modern', {
      elicitation: { url: {} },
    })
    const planned = await eliciting.call('migration_plan', {
      target: w.ids.productionTarget,
      migrationIds: [migration],
      defaults: DEFAULTS,
    })
    const planId = planned.structuredContent?.['id'] as string
    const planHash = planned.structuredContent?.['planHash'] as string

    const first = await eliciting.request('tools/call', {
      name: 'plan_apply',
      arguments: { planId },
    })
    expect(first.status, first.text).toBe(200)
    const round = first.body.result
    expect(round.resultType).toBe('input_required')
    const approval = round.inputRequests.approval
    expect(approval.method).toBe('elicitation/create')
    expect(approval.params).toEqual({
      mode: 'url',
      url: expect.stringMatching(
        new RegExp(`^${ORIGIN}/approvals#operation=op_[0-9A-HJKMNP-TV-Z]{26}$`),
      ),
      // Fixed server text from checked facts: never the agent's words or the plan's content.
      message: `ExponetDB: a person must approve migration.apply on ${w.ids.slug}/platform/production (prod), plan hash ${planHash.slice(0, 27)}…. Open the link, review the plan and decide there; the agent cannot approve it.`,
    })
    expect(round.requestState).toMatch(/^rs1\.1\.[A-Za-z0-9_-]+$/)
    const operationId = String(approval.params.url).split('#operation=')[1] ?? ''
    // The operation exists before the link is shown, and waits for a person.
    expect(
      (await eliciting.call('operation_get', { operationId })).structuredContent,
    ).toMatchObject({
      state: 'awaiting_approval',
    })

    // The retry: the normal result, read from the operation; an "accept" decides nothing.
    const retried = await eliciting.request('tools/call', {
      name: 'plan_apply',
      arguments: { planId },
      requestState: round.requestState,
      inputResponses: { approval: { action: 'accept' } },
    })
    expect(retried.body.result.resultType).toBe('complete')
    expect(retried.body.result.structuredContent).toMatchObject({
      id: operationId,
      state: 'awaiting_approval',
      approvalUrl: `${ORIGIN}/approvals#operation=${operationId}`,
    })

    // A state opens only for its principal, tool and arguments, and only unaltered.
    const refusedState = async (
      caller: McpCaller,
      args: Record<string, unknown>,
      state: string,
    ) => {
      const r = await caller.request('tools/call', {
        name: 'plan_apply',
        arguments: args,
        requestState: state,
      })
      expect(r.body.result.isError, r.text.slice(0, 300)).toBe(true)
      expect(r.body.result.content[0].text).toMatch(/^Refused: VALIDATION_FAILED\./)
      expect(r.body.result.content[0].text).toContain('/requestState')
    }
    const tampered = `${round.requestState.slice(0, -2)}${round.requestState.endsWith('A') ? 'B' : 'A'}A`
    await refusedState(eliciting, { planId }, tampered)
    await refusedState(eliciting, { planId: staged.structuredContent?.['id'] }, round.requestState)
    await refusedState(agent, { planId }, round.requestState)

    // A client that declared form elicitation only, and a legacy client: the link in the result.
    const formOnly = new McpCaller(w.app, prodAgent.token, 'modern', { elicitation: {} })
    const plain = await formOnly.request('tools/call', {
      name: 'plan_apply',
      arguments: { planId },
    })
    expect(plain.body.result.resultType).toBe('complete')
    expect(plain.body.result.structuredContent).toMatchObject({ id: operationId })
    const legacy = new McpCaller(w.app, prodAgent.token, 'legacy')
    const old = await legacy.call('plan_apply', { planId })
    expect(old.structuredContent).toMatchObject({ id: operationId, state: 'awaiting_approval' })
    expect(old.content[0]?.text).toContain(`${ORIGIN}/approvals#operation=${operationId}`)

    await prodAgent.call('operation_cancel', { operationId })
  })

  it('refuses a denied plan with PLAN_DENIED, withdraws, cancels a waiting operation', async () => {
    // Never applied on staging: production is denied (no evidence), and stays denied.
    const unproven = newUlid(Date.now())
    const denied = await prodAgent.call('migration_plan', {
      target: w.ids.productionTarget,
      bundles: [notesBundle(unproven, 'remarks')],
      defaults: DEFAULTS,
    })
    const plan = denied.structuredContent ?? {}
    expect(plan['decision']).toBe('deny')
    expect(denied.content[0]?.text).toContain('The policy denies it; it cannot be applied.')
    const refused = await prodAgent.call('plan_apply', { planId: plan['id'] })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toMatch(/^Refused: PLAN_DENIED\./)

    // Withdraw a fresh plan: it can no longer be applied.
    const second = newUlid(Date.now() + 1)
    const fresh = await agent.call('migration_plan', {
      target: w.ids.stagingTarget,
      bundles: [notesBundle(second, 'tags')],
      defaults: DEFAULTS,
    })
    const withdrawn = await agent.call('plan_withdraw', { planId: fresh.structuredContent?.['id'] })
    expect(withdrawn.isError, withdrawn.content[0]?.text.slice(0, 300)).toBeUndefined()
    const late = await agent.call('plan_apply', { planId: fresh.structuredContent?.['id'] })
    expect(late.isError).toBe(true)

    // A waiting operation can be canceled by the agent that applied it.
    const third = newUlid(Date.now() + 2)
    const onStaging = await agent.call('migration_plan', {
      target: w.ids.stagingTarget,
      bundles: [notesBundle(third, 'labels')],
      defaults: DEFAULTS,
    })
    const op = await agent.call('plan_apply', { planId: onStaging.structuredContent?.['id'] })
    await settle(agent, op.structuredContent?.['id'])
    const prodPlan = await prodAgent.call('migration_plan', {
      target: w.ids.productionTarget,
      migrationIds: [third],
      defaults: DEFAULTS,
    })
    const waiting = await prodAgent.call('plan_apply', {
      planId: prodPlan.structuredContent?.['id'],
    })
    expect(waiting.structuredContent?.['state']).toBe('awaiting_approval')
    const canceled = await prodAgent.call('operation_cancel', {
      operationId: waiting.structuredContent?.['id'],
    })
    expect(canceled.isError, canceled.content[0]?.text.slice(0, 300)).toBeUndefined()
    expect(canceled.structuredContent?.['state']).toBe('canceled')
  })

  it('a stale plan names what changed', async () => {
    const a = newUlid(Date.now())
    const b = newUlid(Date.now() + 1)
    const planned = await agent.call('migration_plan', {
      target: w.ids.stagingTarget,
      bundles: [notesBundle(a, 'first_stale')],
      defaults: DEFAULTS,
    })
    expect(planned.isError, planned.content[0]?.text.slice(0, 600)).toBeUndefined()
    // Another migration lands first.
    const other = await agent.call('migration_plan', {
      target: w.ids.stagingTarget,
      bundles: [notesBundle(b, 'second_stale')],
      defaults: DEFAULTS,
    })
    const op = await agent.call('plan_apply', { planId: other.structuredContent?.['id'] })
    await settle(agent, op.structuredContent?.['id'])
    const stale = await agent.call('plan_apply', { planId: planned.structuredContent?.['id'] })
    expect(stale.isError).toBe(true)
    const text = stale.content[0]?.text ?? ''
    expect(text, text.slice(0, 600)).toMatch(/^Refused: PLAN_STALE\./)
    expect(text).toContain('changedBindings')
    expect(text).toContain(String(planned.structuredContent?.['id']))
  })

  it('names the client and the grant in the audit, and filters by them', async () => {
    type Event = {
      id: string
      client: { kind: string; clientId: string | null; grantId: string | null } | null
      refs: { operationId: string | null }
    }
    // The owner reads the audit in the Web App: the first apply was accepted through the
    // agent's client and grant. The worker's events of that operation carry no client;
    // they are attributed through refs.operationId to this accepted event.
    const ofOperation = async (action: string) => {
      const found = await w.owner.browser.call(
        'GET',
        `/api/v1/audit-events?action=${action}&limit=500`,
      )
      expect(found.status, found.text).toBe(200)
      return (found.body.items as Event[]).filter((e) => e.refs.operationId === firstOperation)
    }
    for (const action of ['migration.apply', 'migration.verification']) {
      const worker = await ofOperation(action)
      expect(worker.length, action).toBeGreaterThan(0)
      expect(worker.every((e) => e.client === null)).toBe(true)
    }
    const viaAgent = (await ofOperation('operation.accepted'))[0]
    expect(viaAgent?.client).toMatchObject({
      kind: 'mcp',
      clientId: expect.stringMatching(/^cli_/),
      grantId: expect.stringMatching(/^grt_/),
      sessionId: null,
    })
    const grant = viaAgent?.client?.grantId ?? ''
    const client = viaAgent?.client?.clientId ?? ''

    // audit_search by grant: only that grant's events (the production agent's are another grant).
    const byGrant = await auditor.call('audit_search', { grant, limit: 500 })
    expect(byGrant.isError, byGrant.content[0]?.text.slice(0, 300)).toBeUndefined()
    const items = (byGrant.structuredContent?.['items'] ?? []) as Event[]
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((e) => e.client?.grantId === grant)).toBe(true)
    expect(items.some((e) => e.refs.operationId === firstOperation)).toBe(true)
    // REST parity: the same filter, the same events.
    const rest = await w.owner.browser.call('GET', `/api/v1/audit-events?grant=${grant}&limit=500`)
    expect((rest.body.items as Event[]).map((e) => e.id)).toEqual(items.map((e) => e.id))

    // By client: both grants of the client, never another client.
    const byClient = await auditor.call('audit_search', { client, limit: 500 })
    const clientItems = (byClient.structuredContent?.['items'] ?? []) as Event[]
    expect(clientItems.every((e) => e.client?.clientId === client)).toBe(true)
    expect(new Set(clientItems.map((e) => e.client?.grantId)).size).toBeGreaterThan(1)
    // A malformed grant is refused by the contract, not searched.
    const bad = await auditor.call('audit_search', { grant: 'not-a-grant' })
    expect(bad.content[0]?.text).toMatch(/^Refused: VALIDATION_FAILED\./)
  })

  it('audits a denied high-risk tool call as authz.denied; an ordinary denial is not', async () => {
    type Denied = {
      action: string
      phase: string
      client: { kind: string; clientId: string | null; grantId: string | null } | null
      subject: { targetId: string | null }
      denial: { action: string; reason: string; tool: string | null } | null
      result: { status: string; errorCode: string | null }
    }
    const reader = new McpCaller(
      w.app,
      (await w.mcpToken(clientId, READ, ['nonprod'])).access_token,
    )
    // Planning without the scope: the one 403 at /mcp (insufficient_scope), and a security signal.
    const planned = await reader.request('tools/call', {
      name: 'migration_plan',
      arguments: { target: w.ids.stagingTarget, migrationIds: [first], defaults: DEFAULTS },
    })
    expect(planned.status).toBe(403)
    expect(planned.headers.get('www-authenticate')).toContain('error="insufficient_scope"')
    // Reading the audit without the scope: an ordinary denial (log and metric only).
    const read = await reader.request('tools/call', { name: 'audit_search', arguments: {} })
    expect(read.status).toBe(403)
    await w.settled()

    const denied = await w.owner.browser.call(
      'GET',
      '/api/v1/audit-events?action=authz.denied&limit=50',
    )
    expect(denied.status, denied.text).toBe(200)
    const events = denied.body.items as Denied[]
    const plan = events.filter((e) => e.denial?.tool === 'migration_plan')
    expect(plan).toHaveLength(1)
    expect(plan[0]).toMatchObject({
      phase: 'denied',
      client: {
        kind: 'mcp',
        clientId: expect.stringMatching(/^cli_/),
        grantId: expect.stringMatching(/^grt_/),
      },
      // Refused before the target is resolved: the event names no subject.
      subject: { targetId: null },
      denial: { action: 'migration.plan', reason: 'delegated_scope', tool: 'migration_plan' },
      result: { status: 'denied', errorCode: 'INSUFFICIENT_SCOPE' },
    })
    expect(events.some((e) => e.denial?.action === 'audit.search')).toBe(false)
    // No argument value is recorded: the migration id appears nowhere in the event.
    expect(JSON.stringify(plan[0])).not.toContain(first)
  })

  it('keeps the last use of each grant: the minute and the class, at most one write a minute', async () => {
    await w.settled()
    type Use = { grant_id: string; last_used_at: Date; use_class: string }
    const uses = await w.db.asSuperuser(
      async (c) =>
        (await c.query<Use>('SELECT grant_id, last_used_at, use_class FROM oauth.grant_last_use'))
          .rows,
    )
    // agent, prodAgent, auditor, the reader: every grant that was used, one row each.
    expect(
      uses.length,
      w.logLines.filter((l) => l.includes('grant_use')).join('\n') || 'no failure logged',
    ).toBeGreaterThanOrEqual(4)
    for (const use of uses) {
      expect(use.last_used_at.getUTCSeconds() + use.last_used_at.getUTCMilliseconds()).toBe(0)
      expect(['read', 'plan', 'apply', 'data']).toContain(use.use_class)
    }
    // The upsert never moves a use back and writes once a minute; serve never deletes one.
    const store = w.db.store('exdb_serve')
    try {
      const grantId = uses[0]?.grant_id as GrantId
      // A minute an hour ahead: later than any use the tests made.
      const minute = Math.floor(Date.now() / 60_000) * 60_000 + 3_600_000
      await oauth.recordGrantUse(store, grantId, 'apply', new Date(minute + 5_000))
      await oauth.recordGrantUse(store, grantId, 'read', new Date(minute + 50_000))
      await oauth.recordGrantUse(store, grantId, 'data', new Date(minute - 120_000))
      expect(await oauth.readGrantUse(store, grantId)).toEqual({
        lastUsedAt: new Date(minute).toISOString().replace('.000Z', 'Z'),
        useClass: 'apply',
      })
      await oauth.recordGrantUse(store, grantId, 'read', new Date(minute + 60_000))
      expect((await oauth.readGrantUse(store, grantId))?.useClass).toBe('read')
      await expect(store.query('test.delete', 'DELETE FROM oauth.grant_last_use')).rejects.toThrow()
    } finally {
      await store.close()
    }
  })

  it('never takes a break-glass grant, and a critical plan is for people only', async () => {
    const withGrant = await prodAgent.call('migration_plan', {
      target: w.ids.productionTarget,
      migrationIds: [first],
      breakGlassGrantId: 'bgl_01M4S0000000000000000000ZZ',
    })
    expect(withGrant.content[0]?.text).toMatch(/^Refused: VALIDATION_FAILED\./)

    const rollback = await prodAgent.call('migration_rollback_plan', {
      target: w.ids.productionTarget,
      migrationId: first,
    })
    // No down.sql in this bundle: nothing to roll back, said as a tool error.
    expect(rollback.isError).toBe(true)

    // A lossy rollback: on staging an agent may plan and apply it (class high, nonprod) ...
    const lossy = newUlid(Date.now())
    const withDown = bundle({
      id: lossy,
      name: 'add-scratch',
      up: ADD_NOTES.replaceAll('notes', 'scratch'),
      verify: NOTES_VERIFY.replaceAll('notes', 'scratch'),
      down: { sql: 'ALTER TABLE public.accounts DROP COLUMN scratch;\n', safety: 'lossy' },
    })
    const staged = await agent.call('migration_plan', {
      target: w.ids.stagingTarget,
      bundles: [withDown],
      defaults: DEFAULTS,
    })
    expect(staged.isError, staged.content[0]?.text.slice(0, 400)).toBeUndefined()
    const stagedOp = await agent.call('plan_apply', { planId: staged.structuredContent?.['id'] })
    expect(await settle(agent, stagedOp.structuredContent?.['id'])).toMatchObject({
      state: 'succeeded',
    })
    const prodPlan = await prodAgent.call('migration_plan', {
      target: w.ids.productionTarget,
      migrationIds: [lossy],
      defaults: DEFAULTS,
    })
    const prodOp = await prodAgent.call('plan_apply', {
      planId: prodPlan.structuredContent?.['id'],
    })
    await w.owner.reauth()
    const approved = await w.owner.browser.call(
      'POST',
      `/api/v1/approvals/${prodOp.structuredContent?.['id']}/approve`,
      { planHash: prodPlan.structuredContent?.['planHash'], acknowledgeSelfApproval: true },
    )
    expect(approved.status, approved.text).toBe(200)
    expect(await settle(prodAgent, prodOp.structuredContent?.['id'])).toMatchObject({
      state: 'succeeded',
    })

    // ... on production it is critical: the agent may propose it, never apply it.
    const critical = await prodAgent.call('migration_rollback_plan', {
      target: w.ids.productionTarget,
      migrationId: lossy,
    })
    expect(critical.isError, critical.content[0]?.text.slice(0, 400)).toBeUndefined()
    expect(critical.structuredContent).toMatchObject({ class: 'critical' })
    const refused = await prodAgent.call('plan_apply', {
      planId: critical.structuredContent?.['id'],
    })
    expect(refused.isError).toBe(true)
    // The next step is a person's: the refusal names it and the plan, nothing more.
    expect(refused.content[0]?.text).toMatch(
      /^Refused: HUMAN_APPLY_REQUIRED\. Next step: Give the plan id to your person: .*exponetdb plan apply <planId>/,
    )
    expect(refused.content[0]?.text).toContain(`"planId":"${critical.structuredContent?.['id']}"`)
    await w.settled()
    const denials = await w.owner.browser.call(
      'GET',
      '/api/v1/audit-events?action=authz.denied&limit=50',
    )
    expect(
      (denials.body.items as { denial: { action: string; reason: string; tool: string } }[]).some(
        (e) =>
          // A critical plan narrows the client kinds to a person's session (the engine's reason).
          e.denial.action === 'plan.apply' &&
          e.denial.reason === 'client_kind' &&
          e.denial.tool === 'plan_apply',
      ),
    ).toBe(true)
  })
})
