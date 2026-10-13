import type { SchemaObjectRef } from '@exponetdb/sdk/operations'
import type { SqlCompletionItem, SqlCompletionProvider } from '@exponetdb/ui-data'
import type { QueryClient } from '@tanstack/react-query'
import type { ApiClient } from '../../lib/api/client.ts'
import { t } from '../../lib/i18n/i18n.ts'
import { COMPLETION_MAX_Q, completionQuery } from './keys.ts'

/**
 * Completion from the API (OD-40, order §8): the word being typed is a name
 * search on the target (`GET /targets/{t}/schema/search`, one page of 50,
 * cached for a minute), asked only when the editor asks. The browser never
 * holds the catalog. Columns are not searchable through the API, so they are
 * not completed.
 */
const PLAIN_IDENTIFIER = /^[a-z_][a-z0-9_$]*$/

const RELATION_KINDS = ['table', 'view', 'materialized_view', 'function'] as const
const TOP_KINDS = ['schema', ...RELATION_KINDS] as const

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

export function createCompletionProvider(
  client: ApiClient,
  queryClient: QueryClient,
  path: string,
): SqlCompletionProvider {
  return async ({ word }) => {
    const parts = word.split('.')
    const last = parts[parts.length - 1] ?? ''
    const qualifier = parts.length > 1 ? unquote(parts[parts.length - 2] ?? '') : undefined
    if (last.length === 0 || last.length > COMPLETION_MAX_Q) return []
    const kinds = qualifier === undefined ? TOP_KINDS : RELATION_KINDS
    const page = await queryClient.fetchQuery(completionQuery(client, path, kinds, last))
    return completionItems(page.items, qualifier)
  }
}
