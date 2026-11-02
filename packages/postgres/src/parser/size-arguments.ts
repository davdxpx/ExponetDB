import { type JsonNode, names, nodeType, walk } from './parse.ts'

/**
 * The largest size a data read may ask a value-building function for
 * (VC-002, [sql-execution-security.md §2.4](../../../../exponetdb-docs/03-database-model/sql-execution-security.md#24-wave-7-implementation)):
 * the count of `repeat`, the length of `lpad` and `rpad`, the elements of
 * `array_fill`, every width of a `format` string and the length of a cast to
 * `char(n)` or `bit(n)` (both pad the value to `n`). PostgreSQL has no
 * per-query memory limit, and `work_mem` does not bound an aggregate of such
 * values: `array_agg(repeat('x', 100000000))` over 100 rows asked for about
 * 10 GB within a second and made the kernel restart the target's cluster.
 * The size must be a constant (a column, a parameter or an expression is
 * refused), so the bound is known before the read runs. It bounds one
 * built value only: rows times values stays the residual risk of OD-68.
 */
export const MAX_SIZE_ARGUMENT = 10_000

/** `pg_catalog` functions whose argument at `index` is a size. */
const SIZED: ReadonlyMap<string, number> = new Map([
  ['repeat', 1],
  ['lpad', 1],
  ['rpad', 1],
])

/** `%[position$][-][width]`: a width is digits, or `*` (an argument: never a constant here). */
const FORMAT_SPEC = /%(?:%|(?:\d+\$)?-*(\*|\d+)?)/g

/** An integer literal's value; `undefined` for anything that is not one. */
function integerConstant(value: unknown): number | undefined {
  const n = nodeType(value)
  if (n?.type !== 'A_Const') return undefined
  const ival = n.body['ival']
  if (typeof ival !== 'object' || ival === null) return undefined
  // The JSON tree omits a zero value (`ival: {}`).
  const v = (ival as JsonNode)['ival']
  return v === undefined ? 0 : typeof v === 'number' ? v : undefined
}

function arrayElements(value: unknown): number | undefined {
  const n = nodeType(value)
  if (n?.type !== 'A_ArrayExpr' || !Array.isArray(n.body['elements'])) return undefined
  let product = 1
  for (const element of n.body['elements']) {
    const v = integerConstant(element)
    if (v === undefined) return undefined
    product *= Math.max(v, 0)
  }
  return product
}

function formatBounded(value: unknown): boolean {
  const n = nodeType(value)
  const sval = n?.type === 'A_Const' ? n.body['sval'] : undefined
  const text = typeof sval === 'object' && sval !== null ? (sval as JsonNode)['sval'] : undefined
  if (typeof text !== 'string') return false
  for (const [, width] of text.matchAll(FORMAT_SPEC)) {
    if (width === '*' || (width !== undefined && Number(width) > MAX_SIZE_ARGUMENT)) return false
  }
  return true
}

/** Types whose cast pads a value to its length (`'x'::char(10000000)` is 10 MB). */
const PADDED_TYPES: ReadonlySet<string> = new Set(['bpchar', 'bit'])

/** What a cast to `char(n)` or `bit(n)` refuses, or `undefined` when `n` is bounded. */
function castRefusal(typeName: unknown): string | undefined {
  if (typeof typeName !== 'object' || typeName === null) return undefined
  const t = typeName as JsonNode
  const parts = names(t['names'])
  const name = parts?.[parts.length - 1]
  if (name === undefined || !PADDED_TYPES.has(name)) return undefined
  const typmods = Array.isArray(t['typmods']) ? t['typmods'] : []
  return typmods.every((m) => {
    const v = integerConstant(m)
    return v !== undefined && v <= MAX_SIZE_ARGUMENT
  })
    ? undefined
    : `char(n), bit(n): n of at most ${MAX_SIZE_ARGUMENT} (the value is padded to n)`
}

/** What a call of `name` with `args` refuses, or `undefined` when its size is bounded. */
function callRefusal(name: string, args: readonly unknown[]): string | undefined {
  const index = SIZED.get(name)
  if (index !== undefined) {
    const v = integerConstant(args[index])
    return v !== undefined && v <= MAX_SIZE_ARGUMENT
      ? undefined
      : `${name}(…, n): n must be a constant of at most ${MAX_SIZE_ARGUMENT}`
  }
  if (name === 'array_fill') {
    const elements = arrayElements(args[1])
    return elements !== undefined && elements <= MAX_SIZE_ARGUMENT
      ? undefined
      : `array_fill(…, dims): at most ${MAX_SIZE_ARGUMENT} elements`
  }
  if (name === 'format') {
    return formatBounded(args[0])
      ? undefined
      : `format: a constant format with widths of at most ${MAX_SIZE_ARGUMENT}`
  }
  return undefined
}

/**
 * The first value-building call of an admitted read whose size is not a
 * constant within {@link MAX_SIZE_ARGUMENT}: its construct text and node.
 * Other schemas' functions are refused before this runs.
 */
export function sizeArgumentRefusal(
  root: unknown,
): { readonly construct: string; readonly body: JsonNode } | undefined {
  let found: { construct: string; body: JsonNode } | undefined
  walk(root, (type, body) => {
    if (found !== undefined) return false
    if (type === 'TypeCast') {
      const construct = castRefusal(body['typeName'])
      if (construct !== undefined) found = { construct, body }
      return true
    }
    if (type !== 'FuncCall') return true
    const parts = names(body['funcname'])
    const name = parts?.[parts.length - 1]
    if (name === undefined || (parts?.length === 2 && parts[0] !== 'pg_catalog')) return true
    const args = Array.isArray(body['args']) ? body['args'] : []
    const construct = callRefusal(name, args)
    if (construct !== undefined) found = { construct, body }
    return true
  })
  return found
}
