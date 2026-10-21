import type { MessageKey } from '../../lib/i18n/i18n.ts'

/**
 * The title of a plan (and of an operation, which carries the same kind) as
 * data: which catalog sentence says what happens, and which subject goes into
 * its `{subject}` placeholder. Pure; the page renders the subject's name as
 * untrusted text (C-26) or, when the name could not be read, its ID. Nothing
 * here decides anything: an unknown kind gets the generic "Run <kind>".
 */

/** What a kind's title names: a target by path, a cluster, a server, a node, or nothing. */
export type TitleSubjectKind = 'target' | 'cluster' | 'server' | 'node' | 'none'

interface KindTitle {
  readonly key: MessageKey
  readonly subject: TitleSubjectKind
  /** Node kinds: the sentence with the node's ID when the server's name is not known. */
  readonly byId?: MessageKey
}

const target = (key: MessageKey): KindTitle => ({ key, subject: 'target' })
const cluster = (key: MessageKey): KindTitle => ({ key, subject: 'cluster' })
const none = (key: MessageKey): KindTitle => ({ key, subject: 'none' })
const node = (key: MessageKey, byId: MessageKey): KindTitle => ({ key, subject: 'node', byId })

/** The kinds of plans and operations of the contract, by their title sentence. */
export const KIND_TITLES: Readonly<Record<string, KindTitle>> = {
  'target.register': target('plans.title.target.register'),
  'target.suspend': target('plans.title.target.suspend'),
  'target.resume': target('plans.title.target.resume'),
  'target.decommission': target('plans.title.target.decommission'),
  'target.identity.stamp': target('plans.title.target.identity.stamp'),
  'ledger.initialize': target('plans.title.ledger.initialize'),
  'ledger.reconcile': target('plans.title.ledger.reconcile'),
  'migration.apply': target('plans.title.migration.apply'),
  'migration.verify': target('plans.title.migration.verify'),
  'migration.rollback': target('plans.title.migration.rollback'),
  'migration.baseline': target('plans.title.migration.baseline'),
  'migration.import.replay': target('plans.title.migration.import.replay'),
  'migration.resume': target('plans.title.migration.resume'),
  'migration.rebaseline': target('plans.title.migration.rebaseline'),
  'drift.accept': target('plans.title.drift.accept'),
  'connections.cancel': target('plans.title.connections.cancel'),
  'connections.terminate': target('plans.title.connections.terminate'),
  'restore.execute': target('plans.title.restore.execute'),
  'credential.rotate': cluster('plans.title.credential.rotate'),
  'postgres.config.apply': cluster('plans.title.postgres.config.apply'),
  'postgres.reload': cluster('plans.title.postgres.reload'),
  'postgres.restart': cluster('plans.title.postgres.restart'),
  'postgres.tls.rotate': cluster('plans.title.postgres.tls.rotate'),
  'postgres.roles.apply': cluster('plans.title.postgres.roles.apply'),
  'postgres.roles.verifier.set': cluster('plans.title.postgres.roles.verifier.set'),
  'postgres.extensions.apply': cluster('plans.title.postgres.extensions.apply'),
  'postgres.hba.apply': cluster('plans.title.postgres.hba.apply'),
  'backup.run': cluster('plans.title.backup.run'),
  'registry.cluster.confirm': cluster('plans.title.registry.cluster.confirm'),
  'registry.cluster.declare_tier': cluster('plans.title.registry.cluster.declare_tier'),
  'registry.endpoint.add': cluster('plans.title.registry.endpoint.add'),
  'registry.endpoint.retire': cluster('plans.title.registry.endpoint.retire'),
  'registry.database.register': cluster('plans.title.registry.database.register'),
  'node.enroll': { key: 'plans.title.node.enroll', subject: 'server' },
  'node.revoke': node('plans.title.node.revoke', 'plans.title.node.revoke.byId'),
  'node.decommission': node('plans.title.node.decommission', 'plans.title.node.decommission.byId'),
  'node.inspect': node('plans.title.node.inspect', 'plans.title.node.inspect.byId'),
  'node.config.update': node(
    'plans.title.node.config.update',
    'plans.title.node.config.update.byId',
  ),
  'packages.apply_update': node(
    'plans.title.packages.apply_update',
    'plans.title.packages.apply_update.byId',
  ),
  'backup.verify': none('plans.title.backup.verify'),
  'operation.force_release': none('plans.title.operation.force_release'),
  'access.role_binding.create': none('plans.title.access.role_binding.create'),
  'access.role_binding.delete': none('plans.title.access.role_binding.delete'),
  'access.policy_settings.update': none('plans.title.access.policy_settings.update'),
  'access.identity.enable': none('plans.title.access.identity.enable'),
  'access.identity.erase': none('plans.title.access.identity.erase'),
  'registry.product.create': none('plans.title.registry.product.create'),
  'registry.environment.create': none('plans.title.registry.environment.create'),
  'registry.environment.update': none('plans.title.registry.environment.update'),
  'registry.project.create': none('plans.title.registry.project.create'),
  'registry.project.update': none('plans.title.registry.project.update'),
  'registry.execution_role_binding.set': none('plans.title.registry.execution_role_binding.set'),
  'registry.execution_role_exception.declare': none(
    'plans.title.registry.execution_role_exception.declare',
  ),
  'registry.execution_role_exception.revoke': none(
    'plans.title.registry.execution_role_exception.revoke',
  ),
  'registry.server.create': none('plans.title.registry.server.create'),
  'registry.cluster.register': none('plans.title.registry.cluster.register'),
}

/** The ids a title can name, from the subject of the plan or operation and its change. */
export interface TitleRefs {
  readonly targetPath: string | null
  readonly targetId: string | null
  readonly clusterId: string | null
  readonly nodeId: string | null
  /** A node plan names its server in its change (`change.content.serverId`). */
  readonly serverId: string | null
}

const ULID = '[0-7][0-9A-HJKMNP-TV-Z]{25}'
const SERVER_ID = new RegExp(`^srv_${ULID}$`)

/** The server a plan's change names (`change.content.serverId`), when it is a server id. */
export function serverIdOf(content: unknown): string | null {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) return null
  const value = (content as Record<string, unknown>)['serverId']
  return typeof value === 'string' && SERVER_ID.test(value) ? value : null
}

/** How many migrations a migration plan's change names; `null` when not known. */
export function migrationCountOf(content: unknown): number | null {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) return null
  const migrations = (content as Record<string, unknown>)['migrations']
  return Array.isArray(migrations) ? migrations.length : null
}

/** What the subject placeholder shows. */
export type TitleSubject =
  /** A target path or a name read from the registry: untrusted text. */
  | { readonly kind: 'name'; readonly text: string }
  /** The ID of the subject, when its name could not be read. */
  | { readonly kind: 'id'; readonly text: string }
  /** No subject is known for a kind that names one. */
  | { readonly kind: 'not_known' }

/** A title as data: the sentence, its count and what fills `{subject}` and `{kind}`. */
export interface TitleSpec {
  readonly key: MessageKey
  readonly count?: number
  /** `undefined`: the sentence has no subject. */
  readonly subject?: TitleSubject
  /** The kind as the server sent it, for the generic sentence. */
  readonly kind?: string
}

/** The names the page has read for the subject (each `undefined` while unread or when the read failed). */
export interface SubjectNames {
  readonly serverName?: string | undefined
  readonly clusterName?: string | undefined
}

function nonEmpty(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value !== ''
}

/** Which subject a kind names. A kind this version does not know names its first id, if any. */
export function titleSubjectKind(kind: string): TitleSubjectKind | undefined {
  return Object.hasOwn(KIND_TITLES, kind) ? KIND_TITLES[kind]?.subject : undefined
}

/**
 * The title of a plan or operation. The subject is the target path for target
 * kinds (or the target's ID without one), the cluster's or server's name once
 * read (else its ID), and for node kinds the name of the node's server (else
 * the node's ID, with the sentence that names a node). `migration.apply`
 * counts its migrations when the change says how many.
 */
export function titleOf(
  kind: string,
  refs: TitleRefs,
  names: SubjectNames,
  migrationCount: number | null = null,
): TitleSpec {
  const entry = Object.hasOwn(KIND_TITLES, kind) ? KIND_TITLES[kind] : undefined
  if (entry === undefined) {
    const id = refs.targetPath ?? refs.targetId ?? refs.clusterId ?? refs.serverId ?? refs.nodeId
    return nonEmpty(id)
      ? {
          key: 'plans.title.other',
          kind,
          subject: { kind: refs.targetPath === id ? 'name' : 'id', text: id },
        }
      : { key: 'plans.title.otherBare', kind }
  }
  switch (entry.subject) {
    case 'none':
      return { key: entry.key }
    case 'target': {
      const subject: TitleSubject = nonEmpty(refs.targetPath)
        ? { kind: 'name', text: refs.targetPath }
        : nonEmpty(refs.targetId)
          ? { kind: 'id', text: refs.targetId }
          : { kind: 'not_known' }
      if (kind === 'migration.apply' && migrationCount !== null && migrationCount > 0) {
        return migrationCount === 1
          ? { key: 'plans.title.migration.apply.one', subject }
          : { key: 'plans.title.migration.apply.many', count: migrationCount, subject }
      }
      return { key: entry.key, subject }
    }
    case 'cluster':
      return {
        key: entry.key,
        subject: nonEmpty(names.clusterName)
          ? { kind: 'name', text: names.clusterName }
          : nonEmpty(refs.clusterId)
            ? { kind: 'id', text: refs.clusterId }
            : { kind: 'not_known' },
      }
    case 'server':
      return {
        key: entry.key,
        subject: nonEmpty(names.serverName)
          ? { kind: 'name', text: names.serverName }
          : nonEmpty(refs.serverId)
            ? { kind: 'id', text: refs.serverId }
            : { kind: 'not_known' },
      }
    case 'node':
      if (nonEmpty(names.serverName)) {
        return { key: entry.key, subject: { kind: 'name', text: names.serverName } }
      }
      return {
        key: entry.byId ?? entry.key,
        subject: nonEmpty(refs.nodeId) ? { kind: 'id', text: refs.nodeId } : { kind: 'not_known' },
      }
  }
}
