import {
  analyzeMigrationSql,
  type ClusterGlobalExpectation,
  type ClusterGlobalForm,
  clusterGlobalStatements,
  expectationKey,
  type GuardStrictness,
  rolesOf,
  type StatementFacts,
} from '@exponetdb/postgres/parser'

/**
 * How one legacy file is replayed on the scratch target
 * ([`legacy-import.md` §2.4](../../../exponetdb-docs/04-migrations/legacy-import.md#24-files-with-cluster-global-effects),
 * Wave 9 order A6). Pure; the parsers of the file's major and of 18 must be
 * loaded (`loadClusterGlobalParsers`). For the legacy replay only: a bundle
 * never goes through this.
 *
 * - Role statements and `DO` blocks of role statements only are **elided**;
 *   what they state is checked on the imported target instead.
 * - A statement only allowed outside a transaction (`CONCURRENTLY`) runs
 *   alone in autocommit between the transactional segments.
 * - A file without statements is not replayed (`no_statements`).
 *
 * Segments are built from the statements' own text as the parser split
 * them; a file without an elision and without an autocommit statement runs
 * exactly as submitted.
 */
export interface ReplaySegment {
  readonly kind: 'transactional' | 'autocommit'
  /** The statements' indexes in the file. */
  readonly statements: readonly number[]
  readonly text: string
}

export interface GlobalEffects {
  readonly statement: number
  readonly form: Exclude<ClusterGlobalForm, 'mixed_do_block'>
  readonly expectations: readonly ClusterGlobalExpectation[]
  readonly unknown: boolean
}

export interface FileReplay {
  readonly segments: readonly ReplaySegment[]
  readonly elided: readonly {
    readonly statement: number
    readonly form: ClusterGlobalForm
    readonly type: string
  }[]
  readonly mixedDoBlocks: readonly number[]
  readonly autocommit: readonly number[]
  readonly globals: readonly GlobalEffects[]
  readonly noStatements: boolean
  /** The file's statements (the migration analysis), for the chain analysis. */
  readonly statements: readonly StatementFacts[]
}

/** The replay of one file, or `undefined` when the file's major cannot parse it. */
export function fileReplay(
  major: 16 | 17 | 18,
  text: string,
  trustedExtensions: readonly string[] = [],
  /** How the history's guards are read ({@link guardStrictness} of every file). */
  strictness: GuardStrictness = 'none',
): FileReplay | undefined {
  const analysis = analyzeMigrationSql(major, text, { trustedExtensions })
  // The parser calls a text without statements (comments only) empty.
  const empty = !analysis.ok && analysis.failure.kind === 'empty'
  const globals = empty ? [] : clusterGlobalStatements(major, text, strictness)
  if ((!analysis.ok && !empty) || globals === undefined) return undefined
  const statements = analysis.ok ? analysis.statements : []
  if (statements.length === 0) {
    return {
      segments: [],
      elided: [],
      mixedDoBlocks: [],
      autocommit: [],
      globals: [],
      noStatements: true,
      statements,
    }
  }
  const elidedForms = new Map<number, ClusterGlobalForm>()
  const mixed: number[] = []
  const effects: GlobalEffects[] = []
  for (const g of globals) {
    if (g.form === 'mixed_do_block') {
      mixed.push(g.index)
      continue
    }
    elidedForms.set(g.index, g.form)
    effects.push({
      statement: g.index,
      form: g.form,
      expectations: g.effects.expectations,
      unknown: g.effects.unknown,
    })
  }
  const kept = statements.filter((s) => !elidedForms.has(s.index))
  const autocommit = kept.filter((s) => s.autocommitOnly).map((s) => s.index)
  let segments: ReplaySegment[]
  if (elidedForms.size === 0 && autocommit.length === 0) {
    segments = [{ kind: 'transactional', statements: statements.map((s) => s.index), text }]
  } else {
    segments = []
    let run: StatementFacts[] = []
    const flush = () => {
      if (run.length === 0) return
      segments.push({
        kind: 'transactional',
        statements: run.map((s) => s.index),
        text: joined(text, run),
      })
      run = []
    }
    for (const s of kept) {
      if (s.autocommitOnly) {
        flush()
        segments.push({ kind: 'autocommit', statements: [s.index], text: joined(text, [s]) })
      } else {
        run.push(s)
      }
    }
    flush()
  }
  return {
    segments,
    elided: [...elidedForms].map(([statement, form]) => ({
      statement,
      form,
      type: statements[statement]?.type ?? '',
    })),
    mixedDoBlocks: mixed,
    autocommit,
    globals: effects,
    noStatements: false,
    statements,
  }
}

function joined(text: string, statements: readonly StatementFacts[]): string {
  return statements.map((s) => `${text.slice(s.start, s.end)};\n`).join('')
}

export interface SurvivingGlobals {
  /** Per file (in chain order), the expectations no later statement supersedes. */
  readonly surviving: readonly (readonly ClusterGlobalExpectation[])[]
}

/**
 * Over the whole chain the last statement about the same thing wins; a
 * role's removal (`DROP ROLE`, a rename) supersedes everything earlier
 * that names the role. A statement inside an `IF EXISTS` guard supersedes
 * nothing: the guard may have been false when the file ran.
 */
export function survivingGlobals(files: readonly FileReplay[]): SurvivingGlobals {
  const flat: { file: number; order: number; e: ClusterGlobalExpectation }[] = []
  for (const [file, f] of files.entries()) {
    for (const g of f.globals) {
      for (const e of g.expectations) flat.push({ file, order: flat.length, e })
    }
  }
  const lastByKey = new Map<string, number>()
  const removedAt = new Map<string, number>()
  for (const x of flat) {
    if (x.e.when !== undefined) continue
    lastByKey.set(expectationKey(x.e), x.order)
    if (x.e.kind === 'role' && !x.e.exists) removedAt.set(x.e.role, x.order)
  }
  const surviving = files.map(() => [] as ClusterGlobalExpectation[])
  for (const x of flat) {
    if ((lastByKey.get(expectationKey(x.e)) ?? -1) > x.order) continue
    const removedLater = rolesOf(x.e).some((r) => (removedAt.get(r) ?? -1) > x.order)
    if (removedLater) continue
    surviving[x.file]?.push(x.e)
  }
  return { surviving }
}
