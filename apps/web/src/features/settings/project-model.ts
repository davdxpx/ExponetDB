import type { Project } from './keys.ts'

/**
 * The projects page as data: the managed schema scope a person types (one
 * schema name per line), what a change of a project would change, and the
 * request body of that change. Pure functions, unit-tested with hostile
 * input. The server decides every rule again (a plan's class, an empty
 * include list, a slug already taken); this only avoids sending what cannot
 * be right and shows, before the plan exists, what it would do.
 */
export const MAX_SCHEMAS = 256
/** A schema name of the contract: 1 to 63 characters, no control character. */
const SCHEMA_NAME = /^[^\p{Cc}]{1,63}$/u

/** The names typed one per line: trimmed, blank lines dropped, in the order typed. */
export function parseSchemas(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** The scope as the server keeps it: unique names in code unit order (the server sorts the same way). */
export function normalizeSchemas(names: readonly string[]): string[] {
  return [...new Set(names)].sort()
}

export type SchemasProblem = 'name' | 'count'

/** What is wrong with a typed list of schema names, or `undefined` when it can be sent. */
export function schemasProblem(text: string): SchemasProblem | undefined {
  const names = parseSchemas(text)
  if (names.length > MAX_SCHEMAS) return 'count'
  return names.every((name) => SCHEMA_NAME.test(name)) ? undefined : 'name'
}

/** What a person edits of a project: its name and the two schema lists, as typed text. */
export interface ProjectDraft {
  readonly displayName: string
  readonly include: string
  readonly exclude: string
}

export function draftOf(project: Project): ProjectDraft {
  return {
    displayName: project.displayName,
    include: (project.managedScope.includeSchemas ?? []).join('\n'),
    exclude: project.managedScope.excludeSchemas.join('\n'),
  }
}

/** One field that would change: what it is now and what it would be. A list is empty for "all" or "none". */
export type DiffRow =
  | { readonly field: 'name'; readonly before: string; readonly after: string }
  | {
      readonly field: 'include' | 'exclude'
      readonly before: readonly string[]
      readonly after: readonly string[]
    }

export interface ProjectChange {
  /** The body of `planProjectChange`: only the fields that change. Empty when nothing does. */
  readonly body: {
    readonly displayName?: string
    readonly managedScope?: {
      readonly includeSchemas?: string[]
      readonly excludeSchemas: string[]
    }
  }
  readonly rows: readonly DiffRow[]
}

/**
 * What the draft would change in the project. The scope is sent whole (the
 * server replaces it): an empty include list is omitted, which means "every
 * schema except the system schemas".
 */
export function projectChange(project: Project, draft: ProjectDraft): ProjectChange {
  const rows: DiffRow[] = []
  const body: {
    displayName?: string
    managedScope?: { includeSchemas?: string[]; excludeSchemas: string[] }
  } = {}
  const name = draft.displayName.trim()
  if (name !== project.displayName) {
    body.displayName = name
    rows.push({ field: 'name', before: project.displayName, after: name })
  }
  const nowInclude = normalizeSchemas(project.managedScope.includeSchemas ?? [])
  const nowExclude = normalizeSchemas(project.managedScope.excludeSchemas)
  const include = normalizeSchemas(parseSchemas(draft.include))
  const exclude = normalizeSchemas(parseSchemas(draft.exclude))
  const includeChanged = JSON.stringify(include) !== JSON.stringify(nowInclude)
  const excludeChanged = JSON.stringify(exclude) !== JSON.stringify(nowExclude)
  if (includeChanged || excludeChanged) {
    body.managedScope = {
      ...(include.length === 0 ? {} : { includeSchemas: include }),
      excludeSchemas: exclude,
    }
  }
  if (includeChanged) rows.push({ field: 'include', before: nowInclude, after: include })
  if (excludeChanged) rows.push({ field: 'exclude', before: nowExclude, after: exclude })
  return { body, rows }
}

/** The environments a project skips the evidence chain for (`evidenceOverride` names them with "none"). */
export function skippedEvidence(project: Project): string[] {
  return Object.entries(project.evidenceOverride)
    .filter(([, value]) => value === 'none')
    .map(([slug]) => slug)
    .sort()
}
