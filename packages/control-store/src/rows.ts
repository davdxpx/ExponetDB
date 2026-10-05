import { ControlStoreError } from './errors.ts'

/**
 * Typed access to result rows. The driver returns untyped rows; every value
 * is checked where it is read, and a mismatch is a `control_store_invalid_result`
 * error instead of a silently wrong type (no `as` casts on database data).
 */
export class Row {
  readonly #row: Readonly<Record<string, unknown>>

  constructor(row: Readonly<Record<string, unknown>>) {
    this.#row = row
  }

  #value(column: string): unknown {
    if (!Object.hasOwn(this.#row, column)) {
      throw new ControlStoreError('control_store_invalid_result')
    }
    return this.#row[column]
  }

  has(column: string): boolean {
    return Object.hasOwn(this.#row, column)
  }

  text(column: string): string {
    const v = this.#value(column)
    if (typeof v !== 'string') {
      throw new ControlStoreError('control_store_invalid_result')
    }
    return v
  }

  textOrNull(column: string): string | null {
    const v = this.#value(column)
    return v === null ? null : this.text(column)
  }

  /** int2/int4, or int8 that the driver returns as text, within the safe integer range. */
  int(column: string): number {
    const v = this.#value(column)
    const n = typeof v === 'string' && /^-?\d{1,16}$/.test(v) ? Number(v) : v
    if (typeof n !== 'number' || !Number.isSafeInteger(n)) {
      throw new ControlStoreError('control_store_invalid_result')
    }
    return n
  }

  intOrNull(column: string): number | null {
    return this.#value(column) === null ? null : this.int(column)
  }

  bool(column: string): boolean {
    const v = this.#value(column)
    if (typeof v !== 'boolean') {
      throw new ControlStoreError('control_store_invalid_result')
    }
    return v
  }

  boolOrNull(column: string): boolean | null {
    return this.#value(column) === null ? null : this.bool(column)
  }

  date(column: string): Date {
    const v = this.#value(column)
    if (!(v instanceof Date) || Number.isNaN(v.getTime())) {
      throw new ControlStoreError('control_store_invalid_result')
    }
    return v
  }

  dateOrNull(column: string): Date | null {
    return this.#value(column) === null ? null : this.date(column)
  }

  bytes(column: string): Uint8Array {
    const v = this.#value(column)
    if (!(v instanceof Uint8Array)) {
      throw new ControlStoreError('control_store_invalid_result')
    }
    return new Uint8Array(v)
  }

  textArray(column: string): string[] {
    const v = this.#value(column)
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
      throw new ControlStoreError('control_store_invalid_result')
    }
    return v.map(String)
  }

  /** A json/jsonb value as parsed by the driver. Callers validate its shape. */
  json(column: string): unknown {
    return this.#value(column)
  }
}

export function rowsOf(rows: readonly Readonly<Record<string, unknown>>[]): Row[] {
  return rows.map((r) => new Row(r))
}

/** Exactly one row, else `control_store_invalid_result`. */
export function single(rows: readonly Readonly<Record<string, unknown>>[]): Row {
  const [first, ...rest] = rows
  if (first === undefined || rest.length > 0) {
    throw new ControlStoreError('control_store_invalid_result')
  }
  return new Row(first)
}

/** At most one row. */
export function optional(rows: readonly Readonly<Record<string, unknown>>[]): Row | undefined {
  if (rows.length > 1) {
    throw new ControlStoreError('control_store_invalid_result')
  }
  const [first] = rows
  return first === undefined ? undefined : new Row(first)
}
