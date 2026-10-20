import { targetHref } from '../../shell/navigation.ts'
import { LINK_MAX_CHARS } from '../sql/sql-model.ts'

/**
 * Links from the schema browser to the SQL page. The text travels in the
 * `sql` search parameter of the SQL page, which opens it in a new tab and
 * never runs it (information-architecture.md section 4). The SQL page does
 * not open a text longer than `LINK_MAX_CHARS`, so such a text gets no link:
 * a link that opens nothing is not offered.
 */
interface TargetPathParts {
  readonly product: string
  readonly project: string
  readonly environment: string
}

export type SqlLinkMode = 'query' | 'draft'

/** The SQL page with `sql` opened in a new tab, or `undefined` when the text is empty or too long to travel in a link. */
export function sqlHref(
  target: TargetPathParts,
  sql: string,
  mode: SqlLinkMode = 'query',
): string | undefined {
  if (sql.length === 0 || sql.length > LINK_MAX_CHARS) return undefined
  const params = new URLSearchParams()
  if (mode === 'draft') params.set('mode', 'draft')
  params.set('sql', sql)
  return `${targetHref(target, '/sql')}?${params.toString()}`
}

/** The SQL page in draft mode with no text: the one place a change starts. */
export function draftHref(target: TargetPathParts): string {
  return `${targetHref(target, '/sql')}?mode=draft`
}

export { LINK_MAX_CHARS }
