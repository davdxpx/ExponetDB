import type { SchemaObjectRef } from '@exponetdb/sdk/operations'
import type { SqlCompletionItem, SqlCompletionProvider } from '@exponetdb/ui-data'
import type { QueryClient } from '@tanstack/react-query'
import type { ApiClient } from '../../lib/api/client.ts'
import { t } from '../../lib/i18n/i18n.ts'
import { qualifiedName } from '../schema/schema-model.ts'
import {
  COMPLETION_MAX_Q,
  completionObjectQuery,
  completionQuery,
  RELATION_LOOKUP_LIMIT,
} from './keys.ts'
import { type RelationName, relationReferences, resolveQualifier } from './relation-scan.ts'

/**
 * Completion from the API (OD-40, order §8): the word being typed is a name
 * search on the target (`GET /targets/{t}/schema/search`, one page of 50,
 * cached for a minute), asked only when the editor asks. The browser never
 * holds the catalog.
 *
 * After `qualifier.` the provider first asks whether the qualifier is an alias
 * or a relation of the statement (`relation-scan.ts`, a completion aid and
 * never a safety decision). If it is, the columns come from one read of that
 * relation (`GET /targets/{t}/schema/objects/{kind}/{name}`), found by an
 * exact name search first and cached for a minute with the search, so a burst
 * of typing reads each relation once. Otherwise the qualifier is a schema, as
 * before. A read that fails offers nothing; it is never shown as "no columns".
 */
const PLAIN_IDENTIFIER = /^[a-z_][a-z0-9_$]*$/

const RELATION_KINDS = ['table', 'view', 'materialized_view', 'function'] as const
const TOP_KINDS = ['schema', ...RELATION_KINDS] as const
/** The kinds of object that have columns. */
const COLUMN_KINDS = ['table', 'view', 'materialized_view'] as const
/** The schema an unqualified name prefers when several schemas hold it. */
const PREFERRED_SCHEMA = 'public'

/** An identifier as SQL text: plain lower-case names as they are, every other one quoted. */
export function sqlIdentifier(name: string): string {
  return PLAIN_IDENTIFIER.test(name) ? name : `"${name.replaceAll('"', '""')}"`
}

function unquote(part: string): string {
  return part.startsWith('"') && part.endsWith('"') && part.length >= 2
    ? part.slice(1, -1).replaceAll('""', '"')
    : part.toLowerCase()
}

function kindOf(ref: SchemaObjectRef): SqlCompletionItem['kind'] {
  switch (ref.kind) {
    case 'schema':
      return 'schema'
    case 'function':
    case 'procedure':
      return 'function'
    default:
      return 'table'
  }
}

export function completionItems(
  refs: readonly SchemaObjectRef[],
  qualifier: string | undefined,
): SqlCompletionItem[] {
  const seen = new Set<string>()
  const items: SqlCompletionItem[] = []
  for (const ref of refs) {
    if (qualifier !== undefined && (ref.kind === 'schema' || ref.schema !== qualifier)) continue
    const label = sqlIdentifier(ref.name)
    const key = `${ref.kind}|${ref.schema}|${label}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push({
      label,
      kind: kindOf(ref),
      detail: t('sql.completion.detail', {
        kind: ref.kind.replaceAll('_', ' '),
        schema: ref.schema,
      }),
    })
  }
  return items
}

/**
 * The relation a name stands for on the target: the table, view or
 * materialized view whose name matches exactly. A name several schemas hold
 * resolves to the one in `public` and to nothing when `public` is not among
 * them (the search path is not known here).
 */
export function pickRelation(
  refs: readonly SchemaObjectRef[],
  wanted: RelationName,
): SchemaObjectRef | undefined {
  const matches = refs.filter(
    (ref) =>
      COLUMN_KINDS.some((kind) => kind === ref.kind) &&
      ref.name === wanted.name &&
      (wanted.schema === undefined || ref.schema === wanted.schema),
  )
  if (matches.length <= 1) return matches[0]
  return matches.find((ref) => ref.schema === PREFERRED_SCHEMA)
}

/** The columns of a relation as completion items: the quoted name, with the type as detail. */
export function columnItems(
  columns: readonly { readonly name: string; readonly type: string }[] | null,
): SqlCompletionItem[] {
  return (columns ?? []).map((column) => ({
    label: sqlIdentifier(column.name),
    kind: 'column',
    detail: column.type,
  }))
}

export function createCompletionProvider(
  client: ApiClient,
  queryClient: QueryClient,
  path: string,
): SqlCompletionProvider {
  /** The columns after `qualifier.`, or `undefined` when the qualifier is not a relation of the statement. */
  const columnsOf = async (
    qualifierParts: readonly string[],
    statement: string,
  ): Promise<SqlCompletionItem[] | undefined> => {
    const wanted = resolveQualifier(relationReferences(statement), qualifierParts)
    if (wanted === undefined || wanted.name.length > COMPLETION_MAX_Q) return undefined
    const found = await queryClient.fetchQuery(
      completionQuery(client, path, COLUMN_KINDS, wanted.name, RELATION_LOOKUP_LIMIT),
    )
    const ref = pickRelation(found.items, wanted)
    const name = ref === undefined ? undefined : qualifiedName(ref)
    if (ref === undefined || name === undefined) return undefined
    const object = await queryClient.fetchQuery(completionObjectQuery(client, path, ref.kind, name))
    return columnItems(object.columns)
  }

  return async ({ word, before, after }) => {
    const parts = word.split('.')
    const last = parts[parts.length - 1] ?? ''
    if (parts.length > 1 && last.length <= COMPLETION_MAX_Q) {
      // The word itself is left out of the scan (`FROM public.` is no relation named public).
      const columns = await columnsOf(parts.slice(0, -1), `${before} 0 ${after ?? ''}`)
      if (columns !== undefined) return columns
    }
    const qualifier = parts.length > 1 ? unquote(parts[parts.length - 2] ?? '') : undefined
    if (last.length === 0 || last.length > COMPLETION_MAX_Q) return []
    const kinds = qualifier === undefined ? TOP_KINDS : RELATION_KINDS
    const page = await queryClient.fetchQuery(completionQuery(client, path, kinds, last))
    return completionItems(page.items, qualifier)
  }
}
