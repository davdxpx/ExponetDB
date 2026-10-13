import type { RelationRef } from './parser/admission.ts'

/**
 * An untrusted read-only statement that may run
 * ([sql-execution-security.md §2](../../../exponetdb-docs/03-database-model/sql-execution-security.md#2-data-queries-dataread)).
 * Like an admitted check, it exists only in a module-private registry: it
 * is created from text the parser admitted for the target's major
 * (`admitRead`: one statement, the read classes, the function, operator,
 * cast and relation allowlists) whose target-side steps passed on that
 * same target (relation kinds: no view or foreign table; user code: no
 * cast, index expression, partition key, statistics expression or range
 * `subtype_diff` that would run code the statement does not name). Only a
 * reader session inside its read-only transaction runs it
 * (`TargetSession.runAdmittedRead`).
 */
export interface AdmittedRead {
  readonly kind: 'admitted_read'
  readonly text: string
  readonly statementClass: 'select' | 'values' | 'table' | 'show' | 'explain'
  /** EXPLAIN ANALYZE executes the statement; the caller decides whether it may. */
  readonly analyze: boolean
  readonly relations: readonly RelationRef[]
}

const ADMITTED = new WeakSet<object>()

export function isAdmittedRead(value: unknown): value is AdmittedRead {
  return typeof value === 'object' && value !== null && ADMITTED.has(value)
}

/** Internal: `reads.ts` creates the read after the target-side steps passed. */
export function registerAdmittedRead(spec: Omit<AdmittedRead, 'kind'>): AdmittedRead {
  const read: AdmittedRead = Object.freeze({
    kind: 'admitted_read',
    text: spec.text,
    statementClass: spec.statementClass,
    analyze: spec.analyze,
    relations: Object.freeze([...spec.relations]),
  })
  ADMITTED.add(read)
  return read
}

/** A column of a read's result as the server described it. */
export interface ReadField {
  readonly name: string
  readonly typeOid: number
  /** The table the column comes from (0 for an expression). */
  readonly tableOid: number
  /** Its attribute number in that table (0 for an expression). */
  readonly columnNumber: number
}

/** The raw result of an admitted read: text values as the server sent them, at most `maxRows`. */
export interface RawRead {
  readonly fields: readonly ReadField[]
  readonly rows: readonly (readonly (string | null)[])[]
  /** More rows existed than `maxRows`. */
  readonly truncated: boolean
}
