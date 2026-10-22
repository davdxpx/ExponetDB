import type { ScratchCheck } from '@exponetdb/contracts'
import type { Queryable } from '@exponetdb/control-store'
import {
  executionRoleFacts,
  extensionPlacements,
  missingObjects,
  type OutsideScopeObject,
  readLedgerRows,
  readMarker,
  referencedOutsideScope,
  snapshotWithin,
  type TargetSession,
} from '@exponetdb/postgres'
import { legacyReferences, loadClusterGlobalParsers } from '@exponetdb/postgres/parser'
import { brand, type Connector, findTarget, type TargetRecord } from '@exponetdb/registry'
import { projectRegistry } from './deps.ts'
import { executionRolesFor, roleUnder } from './execution-roles.ts'

/**
 * The scratch preflight ([`legacy-import.md` §2.5](../../../exponetdb-docs/04-migrations/legacy-import.md#25-scratch-targets),
 * Wave 9 order A7): read only, on observer sessions of both targets, the
 * conditions a replay needs, so an operator prepares the scratch target
 * before an analysis instead of learning from an `incomplete` report. It
 * changes nothing and holds no lock; the replay checks again under its own
 * lock.
 */
type Check = ScratchCheck['checks'][number]

const MAX_ITEMS = 100

function check(
  name: Check['check'],
  status: Check['status'],
  detail: string | null,
  items: readonly string[] = [],
): Check {
  return {
    check: name,
    status,
    detail,
    items: items.slice(0, MAX_ITEMS).map((i) => i.slice(0, 300)),
    truncated: items.length > MAX_ITEMS,
  }
}

const label = (o: OutsideScopeObject) =>
  `${o.kind} ${o.schema}.${o.name}${o.kind === 'function' ? `(${o.args ?? ''})` : ''}`

function errorClass(error: unknown): string {
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && /^[A-Z][A-Z_]+$/.test(code)
    ? code.toLowerCase()
    : 'unreachable'
}

export interface ScratchCheckDeps {
  /** The caller's process connector (observer sessions only). */
  readonly connector: Connector
  readonly installationId: string
}

/**
 * With `files` (the legacy history), the preflight also checks what they
 * reference in schemas outside the managed scope against the scratch
 * target (`legacy_references`, follow-up 2 F3): the imported target's
 * current schema may no longer depend on something an old file needs.
 */
export async function scratchCheck(
  q: Queryable,
  deps: ScratchCheckDeps,
  target: TargetRecord,
  scratchRef: string,
  alias = 'owner',
  files?: readonly { readonly name: string; readonly text: string }[],
): Promise<ScratchCheck> {
  const checkedAt = new Date().toISOString()
  const scratch = await findTarget(q, scratchRef)
  const LATER: readonly Check['check'][] = [
    'identity',
    'empty',
    'extensions',
    'outside_scope',
    'execution_role',
    ...(files === undefined ? [] : (['legacy_references'] as const)),
  ]
  /** The checks after `from` cannot run: unknown, with why. */
  const unknownAfter = (from: Check['check'] | null, detail: string): Check[] =>
    LATER.slice(from === null ? 0 : LATER.indexOf(from) + 1).map((c) => check(c, 'unknown', detail))
  /** Schemas outside the scope the scratch target lacks objects of: to copy schema-only. */
  const copy = new Set<string>()
  const result = (checks: Check[]): ScratchCheck => ({
    targetId: brand('tgt', target.targetId),
    scratchTargetId: scratch === undefined ? null : brand('tgt', scratch.targetId),
    ready: checks.every((c) => c.status === 'pass'),
    checkedAt,
    checks,
    ...(copy.size === 0 ? {} : { copySchemas: [...copy].sort().slice(0, MAX_ITEMS) }),
  })
  // The registry's rules for a scratch target (the analysis refuses the same).
  const unusable =
    scratch === undefined
      ? 'not_found'
      : scratch.targetId === target.targetId
        ? 'same_target'
        : scratch.projectId !== target.projectId
          ? 'other_project'
          : scratch.tier !== 'nonprod'
            ? 'not_nonprod'
            : scratch.state !== 'active' || scratch.placement === null
              ? 'not_active'
              : null
  if (unusable !== null || scratch === undefined || target.placement === null) {
    return result([
      check('scratch_usable', 'fail', unusable ?? 'target_unavailable'),
      ...unknownAfter(null, 'scratch_unusable'),
    ])
  }
  const checks: Check[] = [check('scratch_usable', 'pass', null)]
  const project = await projectRegistry(q, target.projectId)
  const scope = {
    ...(project.scope.includeSchemas === undefined
      ? {}
      : { includeSchemas: [...project.scope.includeSchemas] }),
    excludeSchemas: [...(project.scope.excludeSchemas ?? [])],
  }
  let scratchSession: TargetSession
  try {
    scratchSession = (
      await deps.connector.forTarget(scratch, 'observer', `scratch-check/${scratch.targetId}`)
    ).session
  } catch (error) {
    return result([...checks, ...unknownAfter(null, `scratch_${errorClass(error)}`)])
  }
  try {
    // Identity: this database carries the scratch target's marker and the oid the registry knows.
    const marker = await readMarker(scratchSession)
    const placement = scratch.placement
    const identity =
      marker.status !== 'present'
        ? `marker_${marker.status}`
        : marker.marker.installationId !== deps.installationId ||
            marker.marker.targetId !== scratch.targetId ||
            marker.marker.generation !== scratch.generation
          ? 'marker_mismatch'
          : placement?.databaseOid !== null &&
              placement?.databaseOid !== undefined &&
              placement.databaseOid !== scratchSession.facts.databaseOid
            ? 'database_oid_changed'
            : null
    checks.push(check('identity', identity === null ? 'pass' : 'fail', identity))
    if (identity !== null) {
      return result([...checks, ...unknownAfter('identity', 'identity')])
    }
    const ours = await scratchSession.readOnly(async (rtx) => ({
      snapshot: await snapshotWithin(rtx, scope),
      ledger: await readLedgerRows(rtx),
      extensions: await extensionPlacements(rtx),
    }))
    const objects = ours.snapshot.document.entries
      .filter(
        (e) => e.class !== 'schema' && e.class !== 'extension' && e.class !== 'default_privileges',
      )
      .map((e) => `${e.class} ${e.key.join('.')}`)
    checks.push(
      objects.length === 0 && ours.ledger.length === 0
        ? check('empty', 'pass', null)
        : check(
            'empty',
            'fail',
            ours.ledger.length > 0
              ? `ledger_rows:${ours.ledger.length}`
              : `objects:${objects.length}`,
            objects,
          ),
    )
    // The imported target, read only.
    let theirs:
      | {
          readonly major: number
          readonly extensions: Awaited<ReturnType<typeof extensionPlacements>>
          readonly outside: Awaited<ReturnType<typeof referencedOutsideScope>>
        }
      | undefined
    try {
      const opened = await deps.connector.forTarget(
        target,
        'observer',
        `scratch-check/${target.targetId}`,
      )
      try {
        theirs = await opened.session.readOnly(async (rtx) => ({
          major: opened.session.facts.major,
          extensions: await extensionPlacements(rtx),
          outside: await referencedOutsideScope(rtx, scope),
        }))
      } finally {
        await opened.session.close()
      }
    } catch (error) {
      const detail = `target_${errorClass(error)}`
      checks.push(check('extensions', 'unknown', detail), check('outside_scope', 'unknown', detail))
    }
    if (theirs !== undefined) {
      const outside = theirs.outside
      // The replay runs and parses on the scratch target's major: it must be the imported one's.
      const major = theirs.major !== scratchSession.facts.major
      const differ: string[] = major
        ? [`postgresql: target ${theirs.major}, scratch ${scratchSession.facts.major}`]
        : []
      for (const name of [
        ...new Set([...theirs.extensions.keys(), ...ours.extensions.keys()]),
      ].sort()) {
        const a = theirs.extensions.get(name)
        const b = ours.extensions.get(name)
        if (
          a === undefined ||
          b === undefined ||
          a.schema !== b.schema ||
          a.version !== b.version
        ) {
          const side = (x: typeof a) => (x === undefined ? 'missing' : `${x.schema}@${x.version}`)
          differ.push(`${name}: target ${side(a)}, scratch ${side(b)}`)
        }
      }
      checks.push(
        differ.length === 0
          ? check('extensions', 'pass', null)
          : check(
              'extensions',
              'fail',
              major ? 'major_differs' : `extensions_differ:${differ.length}`,
              differ,
            ),
      )
      const missing = await scratchSession.readOnly((rtx) => missingObjects(rtx, outside.objects))
      for (const m of missing) copy.add(m.schema)
      checks.push(
        outside.truncated
          ? check('outside_scope', 'unknown', 'too_many_objects', missing.map(label))
          : missing.length === 0
            ? check('outside_scope', 'pass', null)
            : check('outside_scope', 'fail', `missing:${missing.length}`, missing.map(label)),
      )
    }
    // The execution role, for the migrator, under the scratch environment's exceptions. The
    // replay creates objects as it, so it must be the role the imported target's environment
    // resolves the alias to: another owner would make every replayed object drift.
    const resolved = await executionRolesFor(q, scratch)
    const role = resolved.roles[alias]
    const imported = (await executionRolesFor(q, target)).roles[alias]
    if (role === undefined) {
      checks.push(check('execution_role', 'fail', 'unmapped_alias'))
    } else if (imported !== undefined && imported !== role) {
      checks.push(check('execution_role', 'fail', 'differs_from_target', [role, imported]))
    } else {
      const [facts] = await scratchSession.readOnly((rtx) =>
        executionRoleFacts(rtx, [role], 'exponetdb_migrator'),
      )
      const problem =
        facts === undefined ? 'missing' : roleUnder(facts, resolved.exceptions).problem
      checks.push(
        problem === null
          ? check('execution_role', 'pass', null, [role])
          : problem === 'declared_exception'
            ? check('execution_role', 'pass', 'declared_exception', [role])
            : check('execution_role', 'fail', problem, [role]),
      )
    }
    if (files !== undefined) {
      const refs = await legacyReferencesCheck(scratchSession, scope, files)
      checks.push(refs.check)
      for (const schema of refs.schemas) copy.add(schema)
    }
    return result(checks)
  } finally {
    await scratchSession.close()
  }
}

/** What the legacy files name outside the managed scope that the scratch target lacks. */
async function legacyReferencesCheck(
  scratch: TargetSession,
  scope: {
    readonly includeSchemas?: readonly string[]
    readonly excludeSchemas: readonly string[]
  },
  files: readonly { readonly name: string; readonly text: string }[],
): Promise<{ readonly check: Check; readonly schemas: readonly string[] }> {
  // The replay parses on the scratch target's major (the extensions check makes it the imported one's).
  const major = scratch.facts.major
  await loadClusterGlobalParsers(major)
  const found = legacyReferences(major, files, scope)
  const missing = await scratch.readOnly((rtx) =>
    missingObjects(
      rtx,
      found.references.map((r) => ({ kind: r.kind, schema: r.schema, name: r.name, args: null })),
    ),
  )
  const firstFile = new Map(
    found.references.map((r) => [`${r.kind} ${r.schema}.${r.name}`, r.file]),
  )
  const items = missing.map((m) => {
    const name = `${m.kind} ${m.schema}.${m.name}${m.kind === 'function' ? '()' : ''}`
    return `${name} (${firstFile.get(`${m.kind} ${m.schema}.${m.name}`) ?? ''})`
  })
  const schemas = [...new Set(missing.map((m) => m.schema))]
  if (missing.length > 0) {
    return {
      check: check('legacy_references', 'fail', `missing:${missing.length}`, items),
      schemas,
    }
  }
  // A file no grammar reads is refused by the replay; what it names is not known here.
  if (found.unparsed.length > 0) {
    return {
      check: check('legacy_references', 'unknown', `unparsed:${found.unparsed.length}`, [
        ...found.unparsed,
      ]),
      schemas,
    }
  }
  return { check: check('legacy_references', 'pass', null), schemas }
}
