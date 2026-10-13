import { appendAuditEvent } from '@exponetdb/audit'
import type { Admission, Authorization, SubjectRef } from '@exponetdb/auth'
import {
  type AuditEventInput,
  type SavedQuery,
  type SavedQueryCreateRequest,
  type SavedQueryList,
  SavedQueryNameSchema,
  SavedQuerySqlSchema,
  type SavedQueryUpdateRequest,
} from '@exponetdb/contracts'
import {
  type ControlStore,
  ControlStoreError,
  type Queryable,
  type Row,
  type Tx,
} from '@exponetdb/control-store'
import { savedQueryDigest } from '@exponetdb/diagnostics'
import { type Clock, type IdentityId, isId, newId } from '@exponetdb/kernel'
import { findTarget, getProject, RegistryError, type TargetRecord } from '@exponetdb/registry'
import type { ReadParties } from './queries.ts'
import type { CallerLike } from './registry.ts'

/**
 * Saved queries (Wave 8, order §9, endpoint 7; sql-execution-security.md
 * §2.7). A saved query is data: a name and a SQL text a person wrote, kept
 * in the Control Store (`savedq.saved_queries`). Saving never runs, admits
 * or classifies the text; running it is an ordinary data read with every
 * check of one.
 *
 * Who sees what (decided here, through the central engine, never by
 * holding an id):
 *
 * - every saved query belongs to one **scope** that never changes: one
 *   target, or one project;
 * - the caller may read data in the scope: for a target, `data.read` on it
 *   at its tier (a restricted grant only on its targets and tiers); for a
 *   project, `data.read` through a binding that **covers the project**
 *   (global, its product or the project itself; a binding on one
 *   environment or one target of it does not), decided like a production
 *   subject of that project, so a delegated caller needs `data.read:prod`
 *   and an unrestricted grant;
 * - and either owns it, or it is a `project` query. A `personal` query is
 *   seen by its owner only.
 *
 * Anything else answers `NOT_FOUND`, exactly like an id that does not
 * exist. Creating, changing and deleting are a person's own records, made
 * in the Web App (self-service actions with the session's `api` scope, so
 * a `data.read` scope never becomes a write scope); the person must also
 * read data in the scope. Only the owner changes or deletes, at the revision the change is
 * based on; the Control Store enforces the same (security-definer
 * functions naming the owner and the revision). The audit records create,
 * update and delete with the digest of the redacted text, never the text
 * and never the name.
 */
export interface SavedQueryHost {
  readonly store: ControlStore
  readonly clock: Clock
  authorize(
    q: Queryable,
    action: string,
    caller: CallerLike,
    subject: SubjectRef,
  ): Promise<Authorization>
  admit(q: Queryable, action: string, caller: CallerLike): Promise<Admission>
  /** The engine's decision without throwing and without a denial event. */
  allowed(q: Queryable, action: string, caller: CallerLike, subject: SubjectRef): Promise<boolean>
  parties(caller: CallerLike): ReadParties
}

interface StoredSavedQuery {
  readonly id: string
  readonly owner: string
  readonly name: string
  readonly sql: string
  readonly digest: string
  readonly visibility: 'personal' | 'project'
  readonly scope:
    | { readonly kind: 'project'; readonly projectId: string }
    | { readonly kind: 'target'; readonly targetId: string }
  readonly revision: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** At most this many rows are examined per list call; the cursor continues the scan. */
const SCAN_LIMIT = 1000
const LIST_CURSOR_PREFIX = 'sq1_'
const COLUMNS = `saved_query_id, owner_identity_id, name, sql_text, sql_digest, visibility,
                 scope_kind, project_id, target_id, revision, created_at, updated_at`

function stored(row: Row): StoredSavedQuery {
  const kind = row.text('scope_kind')
  const visibility = row.text('visibility')
  return {
    id: row.text('saved_query_id'),
    owner: row.text('owner_identity_id'),
    name: row.text('name'),
    sql: row.text('sql_text'),
    digest: row.text('sql_digest'),
    visibility: visibility === 'project' ? 'project' : 'personal',
    scope:
      kind === 'project'
        ? { kind: 'project', projectId: row.text('project_id') }
        : { kind: 'target', targetId: row.text('target_id') },
    revision: row.int('revision'),
    createdAt: row.date('created_at'),
    updatedAt: row.date('updated_at'),
  }
}

/**
 * The subject the engine decides a saved query's scope on: the target
 * itself, or its project as a production subject (the stricter tier; a
 * project's queries may run on its production targets).
 */
function scopeSubject(scope: StoredSavedQuery['scope']): SubjectRef {
  return scope.kind === 'target'
    ? { kind: 'target', targetId: scope.targetId }
    : { kind: 'plan', subject: { projectId: scope.projectId, tier: 'prod' } }
}

function invalid(path: string, message: string): RegistryError {
  return new RegistryError('VALIDATION_FAILED', {
    errors: [{ path, code: 'invalid', message }],
  })
}

/** The bounds of the contract, again at the use case: the name and the text are untrusted. */
function checkText(name: string, sql: string): void {
  if (!SavedQueryNameSchema.safeParse(name).success) {
    throw invalid('/name', 'A name of 1 to 120 characters without control characters.')
  }
  if (!SavedQuerySqlSchema.safeParse(sql).success) {
    throw invalid('/sql', 'A SQL text of 1 to 65,536 characters.')
  }
}

function sqlstate(error: unknown): string | undefined {
  return error instanceof ControlStoreError ? error.sqlstate : undefined
}

function encodeCursor(id: string): string {
  return LIST_CURSOR_PREFIX + id
}

function decodeCursor(cursor: string | undefined): string | null {
  if (cursor === undefined) return null
  const id = cursor.startsWith(LIST_CURSOR_PREFIX) ? cursor.slice(LIST_CURSOR_PREFIX.length) : ''
  if (!isId('sqy', id)) {
    throw invalid('/cursor', 'Unknown cursor.')
  }
  return id
}

export class SavedQueryUseCases {
  readonly #h: SavedQueryHost

  constructor(host: SavedQueryHost) {
    this.#h = host
  }

  #view(q: StoredSavedQuery, identityId: string): SavedQuery {
    return {
      id: q.id,
      name: q.name,
      sql: q.sql,
      sqlDigest: q.digest,
      visibility: q.visibility,
      scope: q.scope,
      ownerIdentityId: q.owner,
      ownedByCaller: q.owner === identityId,
      revision: q.revision,
      createdAt: q.createdAt.toISOString(),
      updatedAt: q.updatedAt.toISOString(),
    } as SavedQuery
  }

  /** Whether the caller may see this saved query (owner or a project query, and data read in its scope). */
  async #visible(
    q: Queryable,
    action: string,
    caller: CallerLike,
    identityId: string,
    saved: StoredSavedQuery,
  ): Promise<boolean> {
    if (saved.owner !== identityId && saved.visibility !== 'project') return false
    return this.#h.allowed(q, action, caller, scopeSubject(saved.scope))
  }

  async #load(q: Queryable, id: string): Promise<StoredSavedQuery | undefined> {
    const { rows } = await q.query(
      'application.saved_query.get',
      `SELECT ${COLUMNS} FROM savedq.saved_queries WHERE saved_query_id = $1`,
      [id],
    )
    const [row] = rows
    return row === undefined ? undefined : stored(row)
  }

  /** The audit of a change: the digest, the scope and the visibility; never the text or the name. */
  async #audit(
    tx: Tx,
    caller: CallerLike,
    action: 'saved_query.create' | 'saved_query.update' | 'saved_query.delete',
    saved: Pick<StoredSavedQuery, 'id' | 'digest' | 'visibility' | 'scope' | 'revision'>,
    target: Pick<TargetRecord, 'targetId' | 'path' | 'tier'> | undefined,
    requestId: string,
  ): Promise<void> {
    const parties = this.#h.parties(caller)
    const event: AuditEventInput = {
      action,
      phase: 'completed',
      actor: {
        kind: parties.actor.kind,
        identityId: parties.actor.identityId,
        label: parties.actor.label as never,
      },
      client: {
        clientId: parties.client.clientId as never,
        kind: parties.client.kind,
        grantId: parties.client.grantId as never,
        ...(parties.client.sessionId === undefined
          ? {}
          : { sessionId: parties.client.sessionId as never }),
      },
      ...(target === undefined
        ? {}
        : {
            subject: {
              targetId: target.targetId as never,
              targetPath: target.path,
              tier: target.tier,
            },
          }),
      request: { requestId: requestId as never },
      changes: {
        savedQueryId: saved.id,
        scopeKind: saved.scope.kind,
        ...(saved.scope.kind === 'project' ? { projectId: saved.scope.projectId } : {}),
        visibility: saved.visibility,
        sqlDigest: saved.digest,
        revision: saved.revision,
      },
      result: { status: 'succeeded' },
    }
    await appendAuditEvent(tx, event, { clock: this.#h.clock })
  }

  /** The target of a target-scoped query, for the audit subject (undefined for a project). */
  async #targetOf(
    q: Queryable,
    scope: StoredSavedQuery['scope'],
  ): Promise<TargetRecord | undefined> {
    return scope.kind === 'target' ? findTarget(q, scope.targetId) : undefined
  }

  /** `GET /saved-queries`: what the caller may read, newest first; optionally one target and its project. */
  async list(
    caller: CallerLike,
    query: {
      readonly target?: string | undefined
      readonly limit?: number | undefined
      readonly cursor?: string | undefined
    },
  ): Promise<SavedQueryList> {
    const before = decodeCursor(query.cursor)
    const limit = query.limit ?? 50
    const identityId = this.#h.parties(caller).actor.identityId
    const store = this.#h.store
    await this.#h.admit(store, 'saved_query.list', caller)
    let filter: { targetId: string; projectId: string } | undefined
    if (query.target !== undefined) {
      const target = await findTarget(store, query.target)
      if (target === undefined) throw new RegistryError('TARGET_NOT_FOUND')
      await this.#h.authorize(store, 'saved_query.list', caller, {
        kind: 'target',
        targetId: target.targetId,
      })
      filter = { targetId: target.targetId, projectId: target.projectId }
    }
    const { rows } = await store.query(
      'application.saved_query.list',
      `SELECT ${COLUMNS} FROM savedq.saved_queries
        WHERE (owner_identity_id = $1 OR visibility = 'project')
          AND ($2::text IS NULL OR target_id = $2 OR project_id = $3)
          AND ($4::text IS NULL OR saved_query_id < $4)
        ORDER BY saved_query_id DESC
        LIMIT $5`,
      [identityId, filter?.targetId ?? null, filter?.projectId ?? null, before, SCAN_LIMIT + 1],
    )
    const decided = new Map<string, boolean>()
    const items: SavedQuery[] = []
    let next: string | null = null
    let scanned = 0
    for (const row of rows) {
      if (scanned === SCAN_LIMIT || items.length === limit) break
      scanned++
      const saved = stored(row)
      const key = JSON.stringify(saved.scope)
      let allowed = decided.get(key)
      if (allowed === undefined) {
        allowed = await this.#h.allowed(
          store,
          'saved_query.list',
          caller,
          scopeSubject(saved.scope),
        )
        decided.set(key, allowed)
      }
      if (allowed) items.push(this.#view(saved, identityId))
      next = encodeCursor(saved.id)
    }
    if (scanned === rows.length) next = null
    return { items, nextCursor: next } as SavedQueryList
  }

  /** `GET /saved-queries/{id}`: a hidden or missing query answers NOT_FOUND alike. */
  async get(caller: CallerLike, id: string): Promise<SavedQuery> {
    const store = this.#h.store
    await this.#h.admit(store, 'saved_query.get', caller)
    const identityId = this.#h.parties(caller).actor.identityId
    const saved = await this.#load(store, id)
    if (
      saved === undefined ||
      !(await this.#visible(store, 'saved_query.get', caller, identityId, saved))
    ) {
      throw new RegistryError('NOT_FOUND')
    }
    return this.#view(saved, identityId)
  }

  /** `POST /saved-queries`: authorized on the scope; nothing runs; audited with the digest only. */
  async create(
    caller: CallerLike,
    body: SavedQueryCreateRequest,
    options: { readonly requestId: string },
  ): Promise<SavedQuery> {
    checkText(body.name, body.sql)
    const store = this.#h.store
    const identityId = this.#h.parties(caller).actor.identityId
    // A person's own record, made in the Web App (a self-service action) ...
    await this.#h.authorize(store, 'saved_query.create', caller, {
      kind: 'self',
      identityId: identityId as IdentityId,
    })
    let scope: StoredSavedQuery['scope']
    let target: TargetRecord | undefined
    if (body.scope.kind === 'target') {
      target = await findTarget(store, body.scope.target)
      if (target === undefined || target.state === 'decommissioned') {
        throw new RegistryError('TARGET_NOT_FOUND')
      }
      // ... in a scope where the person may read data.
      await this.#h.authorize(store, 'saved_query.get', caller, {
        kind: 'target',
        targetId: target.targetId,
      })
      scope = { kind: 'target', targetId: target.targetId }
    } else {
      const projectId = body.scope.projectId
      // A project the caller cannot see answers like one that does not exist.
      if (
        (await getProject(store, projectId)) === undefined ||
        !(await this.#h.allowed(store, 'project.get', caller, { kind: 'project', projectId }))
      ) {
        throw new RegistryError('NOT_FOUND')
      }
      scope = { kind: 'project', projectId }
      await this.#h.authorize(store, 'saved_query.get', caller, scopeSubject(scope))
    }
    const digest = await savedQueryDigest(body.sql, target?.placement?.serverVersionNum ?? null)
    const id = newId('sqy', this.#h.clock.nowMs())
    const visibility = body.visibility ?? 'personal'
    const saved = await store.transaction('application.saved_query.create', async (tx) => {
      const { rows } = await tx.query(
        'application.saved_query.insert',
        `INSERT INTO savedq.saved_queries (saved_query_id, owner_identity_id, name, sql_text, sql_digest,
                                           visibility, scope_kind, project_id, target_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${COLUMNS}`,
        [
          id,
          identityId,
          body.name,
          body.sql,
          digest,
          visibility,
          scope.kind,
          scope.kind === 'project' ? scope.projectId : null,
          scope.kind === 'target' ? scope.targetId : null,
        ],
      )
      const [row] = rows
      if (row === undefined) throw new RegistryError('INTERNAL')
      const created = stored(row)
      await this.#audit(tx, caller, 'saved_query.create', created, target, options.requestId)
      return created
    })
    return this.#view(saved, identityId)
  }

  /**
   * The saved query a change names, if the caller may change it: hidden or
   * missing is NOT_FOUND, someone else's visible query PERMISSION_DENIED.
   */
  async #owned(
    action: 'saved_query.update' | 'saved_query.delete',
    caller: CallerLike,
    id: string,
  ): Promise<StoredSavedQuery> {
    const store = this.#h.store
    const identityId = this.#h.parties(caller).actor.identityId
    await this.#h.authorize(store, action, caller, {
      kind: 'self',
      identityId: identityId as IdentityId,
    })
    const saved = await this.#load(store, id)
    if (
      saved === undefined ||
      !(await this.#visible(store, 'saved_query.get', caller, identityId, saved))
    ) {
      throw new RegistryError('NOT_FOUND')
    }
    if (saved.owner !== identityId) {
      throw new RegistryError('PERMISSION_DENIED')
    }
    return saved
  }

  /** `PUT /saved-queries/{id}`: the owner replaces name, text and visibility at a revision. */
  async update(
    caller: CallerLike,
    id: string,
    body: SavedQueryUpdateRequest,
    options: { readonly requestId: string },
  ): Promise<SavedQuery> {
    checkText(body.name, body.sql)
    const current = await this.#owned('saved_query.update', caller, id)
    const identityId = this.#h.parties(caller).actor.identityId
    const store = this.#h.store
    const target = await this.#targetOf(store, current.scope)
    const digest = await savedQueryDigest(body.sql, target?.placement?.serverVersionNum ?? null)
    try {
      const saved = await store.transaction('application.saved_query.update', async (tx) => {
        await tx.query(
          'application.saved_query.update',
          'SELECT savedq.update_saved_query($1, $2, $3, $4, $5, $6, $7)',
          [id, identityId, body.revision, body.name, body.sql, digest, body.visibility],
        )
        const changed = await this.#load(tx, id)
        if (changed === undefined) throw new RegistryError('INTERNAL')
        await this.#audit(tx, caller, 'saved_query.update', changed, target, options.requestId)
        return changed
      })
      return this.#view(saved, identityId)
    } catch (error) {
      const state = sqlstate(error)
      if (state === 'EXQ03') throw new RegistryError('CONFLICT')
      if (state === 'EXQ02') throw new RegistryError('NOT_FOUND')
      throw error
    }
  }

  /** `DELETE /saved-queries/{id}`: the owner deletes it; audited with the digest of what it held. */
  async remove(
    caller: CallerLike,
    id: string,
    options: { readonly requestId: string },
  ): Promise<{ id: string; deleted: true }> {
    const current = await this.#owned('saved_query.delete', caller, id)
    const identityId = this.#h.parties(caller).actor.identityId
    const store = this.#h.store
    const target = await this.#targetOf(store, current.scope)
    try {
      await store.transaction('application.saved_query.delete', async (tx) => {
        const last = (await this.#load(tx, id)) ?? current
        await tx.query(
          'application.saved_query.delete',
          'SELECT savedq.delete_saved_query($1, $2)',
          [id, identityId],
        )
        await this.#audit(tx, caller, 'saved_query.delete', last, target, options.requestId)
      })
    } catch (error) {
      if (sqlstate(error) === 'EXQ02') throw new RegistryError('NOT_FOUND')
      throw error
    }
    return { id, deleted: true }
  }
}
