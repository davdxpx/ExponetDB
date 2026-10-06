import { isJsonArray, isJsonObject, type JsonValue, parseJson } from '@exponetdb/kernel'

/**
 * A result row of a target query. The session's type parsers are disabled:
 * every value arrives as PostgreSQL's text output (or null), so nothing is
 * converted by JavaScript (no `Date`, no float, no lossy int8). Collections
 * are aggregated to JSON in SQL and parsed here. A value that does not have
 * the expected shape is a protocol error, never a default.
 */
export class RowShapeError extends Error {
  override readonly name = 'RowShapeError'
  readonly column: string
  constructor(column: string) {
    super('A target result column did not have the expected shape.')
    this.column = column
  }
}

export class TargetRow {
  readonly #row: Readonly<Record<string, unknown>>

  constructor(row: Readonly<Record<string, unknown>>) {
    this.#row = row
  }

  #value(column: string): unknown {
    if (!Object.hasOwn(this.#row, column)) {
      throw new RowShapeError(column)
    }
    return this.#row[column]
  }

  has(column: string): boolean {
    return Object.hasOwn(this.#row, column)
  }

  isNull(column: string): boolean {
    return this.#value(column) === null
  }

  text(column: string): string {
    const v = this.#value(column)
    if (typeof v !== 'string') {
      throw new RowShapeError(column)
    }
    return v
  }

  textOrNull(column: string): string | null {
    return this.#value(column) === null ? null : this.text(column)
  }

  /** An integer within the safe range (int2, int4, int8, oid as text). */
  int(column: string): number {
    const v = this.text(column)
    if (!/^-?\d{1,16}$/.test(v) || !Number.isSafeInteger(Number(v))) {
      throw new RowShapeError(column)
    }
    return Number(v)
  }

  intOrNull(column: string): number | null {
    return this.#value(column) === null ? null : this.int(column)
  }

  bool(column: string): boolean {
    const v = this.text(column)
    if (v === 't') return true
    if (v === 'f') return false
    throw new RowShapeError(column)
  }

  boolOrNull(column: string): boolean | null {
    return this.#value(column) === null ? null : this.bool(column)
  }

  json(column: string): JsonValue {
    const parsed = parseJson(this.text(column))
    if (!parsed.ok) {
      throw new RowShapeError(column)
    }
    return parsed.value
  }

  jsonArray(column: string): readonly JsonValue[] {
    if (this.#value(column) === null) {
      return []
    }
    const v = this.json(column)
    if (!isJsonArray(v)) {
      throw new RowShapeError(column)
    }
    return v
  }

  jsonObject(column: string) {
    const v = this.json(column)
    if (!isJsonObject(v)) {
      throw new RowShapeError(column)
    }
    return v
  }
}
