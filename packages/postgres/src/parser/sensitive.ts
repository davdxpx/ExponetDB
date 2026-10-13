import type { SupportedMajor } from './majors.ts'
import { type JsonNode, nodeType, parseWith, walk } from './parse.ts'

/**
 * Masking guards the output; this guards the rest of the statement
 * (sql-execution-security.md §2.4). When a read touches a relation with a
 * masked column, the column may appear only as a bare column of the top
 * level target list of a plain `SELECT`, where its value is masked by its
 * origin. Anywhere else (a predicate, an ordering, a join, a grouping, an
 * expression, a subquery, a CTE, a set operation) it would answer a
 * question about the value through the rows returned, their order, their
 * count or an error. A whole-row reference, a `*` outside the top level,
 * a `USING` list naming the column, a `NATURAL` join, `DISTINCT` and
 * positional `ORDER BY`/`GROUP BY` are refused for the same reason.
 *
 * `columns` are the names of the masked columns of the relations read;
 * the check is by name, so a column of another relation with the same
 * name is refused too (conservative). Returns the offending construct, or
 * `undefined` when the statement only outputs the columns.
 */
export function sensitiveReference(
  major: SupportedMajor,
  text: string,
  columns: ReadonlySet<string>,
): string | undefined {
  if (columns.size === 0) return undefined
  const parsed = parseWith(major, text)
  // An unparsable or multi-statement text never got this far (admission refused it).
  if (!parsed.ok || parsed.statements.length !== 1) return 'statement'
  const stmt = parsed.statements[0]
  if (stmt === undefined) return 'statement'
  let select: JsonNode | undefined
  if (stmt.type === 'SelectStmt') {
    select = stmt.node
  } else if (stmt.type === 'ExplainStmt') {
    const inner = nodeType(stmt.node['query'])
    if (inner?.type !== 'SelectStmt') return 'statement'
    // The plan of an EXPLAIN shows no row; its row counts (ANALYZE) can still answer a predicate.
    return offending({ SelectStmt: inner.body }, columns, new Set(), names(inner.body))
  } else {
    // SHOW reads no relation.
    return undefined
  }
  const plain = select['op'] === undefined || select['op'] === 'SETOP_NONE'
  const allowed = new Set<unknown>()
  // An output name of a masked column (`password AS p`) refers to it in ORDER BY and GROUP BY.
  const masked = new Set(columns)
  if (plain && Array.isArray(select['targetList'])) {
    for (const item of select['targetList']) {
      const target = nodeType(item)
      const value = target?.type === 'ResTarget' ? nodeType(target.body['val']) : undefined
      if (value?.type !== 'ColumnRef') continue
      allowed.add(target?.body['val'])
      const fields = Array.isArray(value.body['fields']) ? value.body['fields'] : []
      const last = nodeType(fields[fields.length - 1])
      const name = last?.type === 'String' ? last.body['sval'] : undefined
      const alias = target?.body['name']
      if (typeof alias === 'string' && typeof name === 'string' && columns.has(name)) {
        masked.add(alias)
      }
    }
  }
  if (Array.isArray(select['distinctClause'])) return 'DISTINCT'
  return offending({ SelectStmt: select }, masked, allowed, names(select))
}

/** Every name a whole-row reference could use: relations, aliases and CTEs of the statement. */
function names(root: JsonNode): Set<string> {
  const out = new Set<string>()
  walk(root, (type, body) => {
    if (type === 'RangeVar' && typeof body['relname'] === 'string') out.add(body['relname'])
    if (type === 'CommonTableExpr' && typeof body['ctename'] === 'string') out.add(body['ctename'])
    const alias =
      typeof body['alias'] === 'object' && body['alias'] !== null
        ? (body['alias'] as JsonNode)
        : undefined
    if (typeof alias?.['aliasname'] === 'string') out.add(alias['aliasname'])
    return true
  })
  return out
}

function offending(
  root: unknown,
  columns: ReadonlySet<string>,
  allowed: ReadonlySet<unknown>,
  relations: ReadonlySet<string>,
): string | undefined {
  let found: string | undefined
  walk(root, (type, body) => {
    if (found !== undefined) return false
    if (type === 'ResTarget' && allowed.has(body['val'])) {
      // A bare top-level output column: masked by its origin. Its own name is not a reference.
      return false
    }
    if (type === 'ColumnRef') {
      const fields = Array.isArray(body['fields']) ? body['fields'] : []
      const last = nodeType(fields[fields.length - 1])
      if (last?.type === 'A_Star') {
        found = '*'
        return false
      }
      const name = last?.type === 'String' ? last.body['sval'] : undefined
      if (typeof name === 'string' && columns.has(name)) {
        found = name
      } else if (typeof name === 'string' && fields.length === 1 && relations.has(name)) {
        found = name
      }
      return false
    }
    if (type === 'JoinExpr') {
      if (body['isNatural'] === true) {
        found = 'NATURAL JOIN'
        return false
      }
      const using = Array.isArray(body['usingClause']) ? body['usingClause'] : []
      for (const item of using) {
        const n = nodeType(item)
        const name = n?.type === 'String' ? n.body['sval'] : undefined
        if (typeof name === 'string' && columns.has(name)) {
          found = name
          return false
        }
      }
    }
    if (type === 'SortBy') {
      // Positional ORDER BY 1 / GROUP BY 1 can name a masked output column.
      const node = nodeType(body['node'])
      if (node?.type === 'A_Const') {
        found = 'position'
        return false
      }
    }
    if (type === 'SelectStmt' && Array.isArray(body['groupClause'])) {
      for (const item of body['groupClause']) {
        if (nodeType(item)?.type === 'A_Const') {
          found = 'position'
          return false
        }
      }
    }
    return true
  })
  return found
}
