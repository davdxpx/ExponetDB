import { type Admission, admitVerifySync, MAX_VERIFY_BYTES, type RelationRef } from './admission.ts'
import { lex } from './lexer.ts'
import type { SupportedMajor } from './majors.ts'
import { parseWith } from './parse.ts'

/**
 * `verify.sql` as a list of checks ([verification.md §4.2, §4.4](../../../../exponetdb-docs/04-migrations/verification.md#42-admission-plan-time)).
 *
 * The parser splits the file; the directives of a check (`-- check:`,
 * `-- covers:`, `-- calls:`, `-- reads-view:`) are the line comments
 * between the previous statement and this one, found with the lexer, so a
 * directive-shaped text inside a string, a dollar-quoted body or a block
 * comment of a statement is never one. Each check is admitted on its own:
 * a declared consumer function is allowed only in the check that declares
 * it. The result names relations and functions per check for the catalog
 * resolution at plan time (the adapter's `resolveVerifyCatalog`).
 */
export interface VerifyCheckSpec {
  readonly index: number
  readonly name: string
  /** `-- covers:` entries (statement indexes of up.sql or object names). */
  readonly covers: readonly string[]
  /** `-- calls: schema.function(argtypes)`. */
  readonly calls: string | null
  /** `-- reads-view: schema.view`. */
  readonly readsView: string | null
  /** The statement text (string range of the file). */
  readonly text: string
  readonly start: number
  readonly end: number
  readonly relations: readonly RelationRef[]
  /** Functions the check calls, qualified (`pg_catalog.count`, `app.visible_leads`). */
  readonly functions: readonly string[]
}

export type VerifyFile =
  | { readonly ok: true; readonly checks: readonly VerifyCheckSpec[] }
  | {
      readonly ok: false
      readonly refusal: Extract<Admission, { ok: false }>
      /** The check (index and name) the refusal is about, when it is about one. */
      readonly check: { readonly index: number; readonly name: string } | null
    }

const DIRECTIVE = /^--\s*(check|covers|calls|reads-view):[ \t]*(.*?)\s*$/
const CALLS = /^([a-z_][a-z0-9_$]*)\.([a-z_][a-z0-9_$]*)\(([^()]*)\)$/
const READS_VIEW = /^([a-z_][a-z0-9_$]*)\.([a-z_][a-z0-9_$]*)$/

/** `schema.function` of a `-- calls:` declaration (lower-case identifiers only), or null. */
export function declaredFunction(calls: string): string | null {
  const m = CALLS.exec(calls)
  return m === null ? null : `${m[1]}.${m[2]}`
}

export function isDeclaredView(readsView: string): boolean {
  return READS_VIEW.test(readsView)
}

/**
 * Where a statement's first token starts: libpg_query's range starts after
 * the previous semicolon and includes the comments in between.
 */
function firstToken(text: string, start: number, end: number): number {
  for (const token of lex(text.slice(start, end))) {
    if (token.kind !== 'space' && token.kind !== 'comment') return start + token.start
  }
  return end
}

interface Directives {
  name: string | null
  covers: string[]
  calls: string | null
  readsView: string | null
}

function directivesIn(region: string): Directives {
  const out: Directives = { name: null, covers: [], calls: null, readsView: null }
  for (const token of lex(region)) {
    if (token.kind !== 'comment') continue
    const comment = region.slice(token.start, token.end)
    if (!comment.startsWith('--')) continue
    const m = DIRECTIVE.exec(comment)
    if (m === null) continue
    const [, directive, value = ''] = m
    if (directive === 'check' && value !== '') out.name = value.slice(0, 120)
    if (directive === 'covers') {
      out.covers.push(
        ...value
          .split(',')
          .map((v) => v.trim())
          .filter((v) => v !== ''),
      )
    }
    if (directive === 'calls') out.calls = value
    if (directive === 'reads-view') out.readsView = value
  }
  return out
}

function refusal(
  reason: Extract<Admission, { ok: false }>['reason'],
  construct?: string,
): Extract<Admission, { ok: false }> {
  return {
    ok: false,
    code: 'VERIFY_CONSTRUCT_UNSUPPORTED',
    reason,
    ...(construct === undefined ? {} : { construct: construct.slice(0, 256) }),
  }
}

export interface VerifyDirectives {
  readonly index: number
  readonly name: string
  readonly covers: readonly string[]
  readonly calls: string | null
  readonly readsView: string | null
  readonly start: number
  readonly end: number
}

/**
 * The checks of a file and their directives, without admission (the lint
 * shows them even when admission refuses); undefined when it does not parse.
 */
export function verifyDirectives(
  major: SupportedMajor,
  text: string,
): VerifyDirectives[] | undefined {
  const parsed = parseWith(major, text)
  if (!parsed.ok) return undefined
  const out: VerifyDirectives[] = []
  let previous = 0
  for (const [index, statement] of parsed.statements.entries()) {
    const begin = firstToken(text, statement.start, statement.end)
    const d = directivesIn(text.slice(previous, begin))
    previous = statement.end
    out.push({
      index,
      name: d.name ?? `check_${index}`,
      covers: d.covers,
      calls: d.calls,
      readsView: d.readsView,
      start: begin,
      end: statement.end,
    })
  }
  return out
}

/** Splits, reads the directives and admits each check (the parser for `major` must be loaded). */
export function analyzeVerifyFile(major: SupportedMajor, text: string): VerifyFile {
  if (new TextEncoder().encode(text).length > MAX_VERIFY_BYTES) {
    return { ok: false, refusal: refusal('too_large'), check: null }
  }
  // The whole file first: statement classes, output columns and the
  // allowlist with every declared consumer function, so the first refusal
  // names the same construct as the lint does.
  if (!parseWith(major, text).ok) {
    const whole = admitVerifySync(major, text)
    return {
      ok: false,
      refusal: whole.ok ? refusal('syntax') : whole,
      check: null,
    }
  }
  const checks: VerifyCheckSpec[] = []
  for (const d of verifyDirectives(major, text) ?? []) {
    const { index, name } = d
    const declared = d.calls === null ? null : declaredFunction(d.calls)
    if (d.calls !== null && declared === null) {
      return { ok: false, refusal: refusal('user_code', d.calls), check: { index, name } }
    }
    if (d.readsView !== null && !isDeclaredView(d.readsView)) {
      return { ok: false, refusal: refusal('user_code', d.readsView), check: { index, name } }
    }
    const statementText = text.slice(d.start, d.end)
    const admission = admitVerifySync(
      major,
      statementText,
      declared === null ? {} : { extraFunctions: new Set([declared]) },
    )
    if (!admission.ok) {
      return { ok: false, refusal: admission, check: { index, name } }
    }
    if (admission.statements !== 1) {
      return { ok: false, refusal: refusal('multiple_statements'), check: { index, name } }
    }
    checks.push({
      index,
      name,
      covers: d.covers,
      calls: d.calls,
      readsView: d.readsView,
      text: statementText,
      start: d.start,
      end: d.end,
      relations: admission.relations,
      functions: admission.functions,
    })
  }
  return { ok: true, checks }
}
