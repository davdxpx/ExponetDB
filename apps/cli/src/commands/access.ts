import { EXIT } from '../cli/exit.ts'
import { arg, flag, listCommand } from '../cli/reads.ts'
import { must } from '../cli/remote.ts'
import type { CommandSpec } from '../cli/types.ts'
import { dash, header } from '../output/format.ts'
import { result } from '../output/model.ts'

/**
 * Access and audit reads ([`08-auth-and-security/`](../../../../exponetdb-docs/08-auth-and-security/authorization.md)):
 * the audit trail (pseudonymous), identities, roles, bindings, grants and
 * OAuth clients as the server shows them. Changes to access are plans the
 * Web App makes with a fresh re-authentication; the CLI only reads here.
 */
const AUDIT = ['audit.read']
const ACCESS = ['access.read']

export const accessCommands: readonly CommandSpec[] = [
  listCommand({
    path: ['audit', 'list'],
    summary: 'Audit events, newest first (actors pseudonymous).',
    group: 'access',
    flags: [
      {
        name: 'from',
        type: 'string',
        placeholder: 'time',
        description: 'From this time (ISO 8601).',
      },
      {
        name: 'to',
        type: 'string',
        placeholder: 'time',
        description: 'Before this time (ISO 8601).',
      },
      {
        name: 'target',
        type: 'string',
        placeholder: 'tgt_…',
        description: 'Only events about this target.',
      },
      {
        name: 'action',
        type: 'string',
        placeholder: 'action',
        description: 'Only this action, e.g. plan.apply.',
      },
      { name: 'mine', type: 'boolean', description: 'Only your own events.' },
      {
        name: 'result',
        type: 'enum',
        values: ['succeeded', 'failed', 'denied'],
        description: 'Only this result.',
      },
      {
        name: 'client',
        type: 'string',
        placeholder: 'cli_…',
        description: 'Only events made through this client (runbook RB-11, RB-15).',
      },
      {
        name: 'grant',
        type: 'string',
        placeholder: 'grt_…',
        description: 'Only events made through this grant.',
      },
    ],
    action: 'audit.search',
    scopes: AUDIT,
    output: 'AuditEventList',
    title: 'audit',
    operation: 'searchAuditEvents',
    noun: 'event',
    query: (i) => ({
      ...(flag(i, 'from') === undefined ? {} : { from: flag(i, 'from') }),
      ...(flag(i, 'to') === undefined ? {} : { to: flag(i, 'to') }),
      ...(flag(i, 'target') === undefined ? {} : { target: flag(i, 'target') }),
      ...(flag(i, 'action') === undefined ? {} : { action: flag(i, 'action') }),
      ...(i.flags['mine'] === true ? { actor: 'self' } : {}),
      ...(i.flags['result'] === undefined ? {} : { result: i.flags['result'] }),
      ...(flag(i, 'client') === undefined ? {} : { client: flag(i, 'client') }),
      ...(flag(i, 'grant') === undefined ? {} : { grant: flag(i, 'grant') }),
    }),
    columns: [
      { title: 'TIME' },
      { title: 'ACTION' },
      { title: 'PHASE' },
      { title: 'RESULT' },
      { title: 'ACTOR' },
      { title: 'SUBJECT', flexible: true },
    ],
    row: (e) => [
      e.occurredAt,
      e.action,
      e.phase,
      e.result.errorCode === null ? e.result.status : `${e.result.status} ${e.result.errorCode}`,
      `${e.actor.label}${e.client === null ? '' : ` via ${e.client.kind}`}`,
      e.subject.targetPath ?? e.subject.targetId ?? e.subject.clusterId ?? e.subject.nodeId ?? '-',
    ],
    empty: 'No audit events match.',
  }),
  {
    path: ['audit', 'show'],
    summary: 'One audit event by id (searched newest first within the filters).',
    group: 'access',
    args: [{ name: 'event', description: 'The event id (aud_…).', required: true }],
    flags: [
      { name: 'from', type: 'string', placeholder: 'time', description: 'Search from this time.' },
      {
        name: 'target',
        type: 'string',
        placeholder: 'tgt_…',
        description: 'Search this target’s events.',
      },
    ],
    locality: 'remote',
    effect: 'read',
    action: 'audit.search',
    scopes: AUDIT,
    output: 'AuditEvent',
    async run(ctx, input) {
      const remote = await ctx.remote()
      const id = arg(input, 'event')
      let scanned = 0
      for await (const page of remote.sdk.pages('searchAuditEvents', undefined, {
        limit: 500,
        ...(flag(input, 'from') === undefined ? {} : { from: flag(input, 'from') }),
        ...(flag(input, 'target') === undefined ? {} : { target: flag(input, 'target') }),
      } as never)) {
        const value = must(page)
        const e = value.items.find((x) => x.id === id)
        if (e !== undefined) {
          return result({
            command: 'audit show',
            data: e,
            blocks: [
              header(`audit ${e.id}`, remote.context),
              {
                kind: 'fields',
                rows: [
                  ['Time', e.occurredAt],
                  ['Action', `${e.action} (${e.phase})`],
                  [
                    'Result',
                    e.result.errorCode === null
                      ? e.result.status
                      : `${e.result.status} ${e.result.errorCode}`,
                  ],
                  ['Actor', `${e.actor.label} (${e.actor.kind})`],
                  [
                    'Client',
                    e.client === null
                      ? null
                      : `${e.client.kind}${e.client.clientId === null ? '' : ` ${e.client.clientId}`}`,
                  ],
                  ['Target', e.subject.targetPath ?? e.subject.targetId],
                  ['Plan', e.refs.planId],
                  ['Plan hash', e.refs.planHash],
                  ['Operation', e.refs.operationId],
                  ['Reason', e.reason],
                ],
              },
            ],
          })
        }
        scanned += value.items.length
        if (scanned >= 10_000) break
      }
      return result({
        command: 'audit show',
        status: 'error',
        exitCode: EXIT.failure,
        error: {
          code: 'NOT_FOUND',
          message: `No event ${id} among the newest ${scanned} you may read; narrow with --from or --target.`,
        },
      })
    },
  },
  listCommand({
    path: ['access', 'identities'],
    summary: 'Identities (people and service accounts).',
    group: 'access',
    action: 'identity.list',
    scopes: ACCESS,
    output: 'IdentityList',
    title: 'identities',
    operation: 'listIdentities',
    noun: 'identity',
    columns: [
      { title: 'IDENTITY' },
      { title: 'KIND' },
      { title: 'LABEL' },
      { title: 'STATE' },
      { title: 'NAME', flexible: true },
    ],
    row: (i) => [i.id, i.kind, i.label, i.state, dash(i.displayName)],
  }),
  {
    path: ['access', 'roles'],
    summary: 'The built-in roles and their permissions.',
    group: 'access',
    locality: 'remote',
    effect: 'read',
    action: 'role.list',
    scopes: ACCESS,
    output: 'RoleList',
    async run(ctx) {
      const remote = await ctx.remote()
      const v = must(await remote.sdk.call('listRoles', {}))
      return result({
        command: 'access roles',
        items: v.items,
        blocks: [
          header('roles', remote.context),
          {
            kind: 'table',
            columns: [
              { title: 'ROLE' },
              { title: 'TITLE' },
              { title: 'PERMISSIONS', flexible: true },
            ],
            rows: v.items.map((r) => [r.id, r.title, r.permissions.join(', ')]),
          },
        ],
      })
    },
  },
  listCommand({
    path: ['access', 'bindings'],
    summary: 'Role bindings (who holds which role where).',
    group: 'access',
    flags: [
      {
        name: 'identity',
        type: 'string',
        placeholder: 'idn_…',
        description: 'Only this identity.',
      },
    ],
    action: 'role_binding.list',
    scopes: ACCESS,
    output: 'RoleBindingList',
    title: 'role bindings',
    operation: 'listRoleBindings',
    noun: 'binding',
    query: (i) => (flag(i, 'identity') === undefined ? {} : { identity: flag(i, 'identity') }),
    columns: [
      { title: 'BINDING' },
      { title: 'IDENTITY' },
      { title: 'ROLE' },
      { title: 'SCOPE', flexible: true },
      { title: 'STATE' },
    ],
    row: (b) => [b.id, b.identityId, b.roleId, JSON.stringify(b.scope), b.state],
  }),
  listCommand({
    path: ['access', 'clients'],
    summary: 'Registered OAuth clients (names are untrusted text).',
    group: 'access',
    action: 'oauth.client.list',
    scopes: ACCESS,
    output: 'OAuthClientList',
    title: 'oauth clients',
    operation: 'listOAuthClients',
    noun: 'client',
    columns: [
      { title: 'CLIENT' },
      { title: 'KIND' },
      { title: 'REGISTRATION' },
      { title: 'STATE' },
      { title: 'NAME', flexible: true },
    ],
    row: (c) => [c.id, c.kind, c.registration, (c as { state?: string }).state ?? '-', c.name],
  }),
]
