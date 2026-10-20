import type { SchemaObjectRef } from '@exponetdb/sdk/operations'
import {
  SchemaTree,
  type SchemaTreeClass,
  type SchemaTreeLoader,
  type SchemaTreeSchema,
  type SchemaTreeSelection,
} from '@exponetdb/ui-data'
import { type Readable, useLinkComponent } from '@exponetdb/ui-patterns'
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import { targetHref } from '../../shell/navigation.ts'
import type { TargetRoute } from '../target/params.ts'
import { SEARCH_MAX_LENGTH } from './keys.ts'
import { ObjectDetail } from './object-detail.tsx'
import { visibilityMissing } from './object-list.tsx'
import { useSchemaOverview } from './queries.ts'
import { objectKeyOfRef, refKey } from './schema-model.ts'
import { DEFAULT_PANEL_STATE, type PanelState } from './search.ts'
import { SearchForm } from './search-controls.tsx'

/** Largest page one class load asks for (the API's page maximum). */
const CLASS_PAGE_LIMIT = 200

/** The classes under a schema, and the kinds of the contract each one asks for. */
interface TreeClass extends SchemaTreeClass {
  readonly kinds: readonly string[]
}

function treeClasses(): readonly TreeClass[] {
  return [
    { id: 'table', label: t('schema.kind.tables'), kinds: ['table'] },
    { id: 'view', label: t('schema.kind.views'), kinds: ['view'] },
    {
      id: 'materialized_view',
      label: t('schema.kind.materialized-views'),
      kinds: ['materialized_view'],
    },
    { id: 'function', label: t('schema.kind.functions'), kinds: ['function', 'procedure'] },
    { id: 'trigger', label: t('schema.kind.triggers'), kinds: ['trigger'] },
    { id: 'index', label: t('schema.kind.indexes'), kinds: ['index'] },
    { id: 'policy', label: t('schema.kind.policies'), kinds: ['policy'] },
    { id: 'sequence', label: t('schema.kind.sequences'), kinds: ['sequence'] },
    { id: 'type', label: t('schema.kind.types'), kinds: ['type'] },
    { id: 'extension', label: t('schema.kind.extensions'), kinds: ['extension'] },
  ]
}

function failedRead<T>(code: string, message: string): Readable<T> {
  return { state: 'failed', error: { code, message } }
}

/**
 * The schema tree: schemas, then the classes under each one, each read the
 * first time it opens. Objects are listed by name search (the only list the
 * API has), so the tree starts when a filter is applied; until then a class
 * says it cannot list without one, which is a failed read and not an empty class.
 */
export function TreePanel(props: { readonly target: TargetRoute }): ReactNode {
  const Link = useLinkComponent()
  const { client } = useApi()
  const [term, setTerm] = useState('')
  const [selected, setSelected] = useState<SchemaObjectRef | undefined>()
  // The tree is not a page of its own: the tab and the row browser's sort and filters stay in the page.
  const [panel, setPanel] = useState<PanelState>(DEFAULT_PANEL_STATE)
  const [kind, setKind] = useState<string | undefined>()
  const known = useRef(new Map<string, SchemaObjectRef>())
  const overview = useSchemaOverview(props.target.path, visibilityMissing)
  const schemas = useMemo(() => mapSchemas(overview.readable), [overview.readable])
  const path = props.target.path
  const classes = useMemo(treeClasses, [])
  const load = useCallback<SchemaTreeLoader>(
    async ({ schema, classId }) => {
      const entry = classes.find((candidate) => candidate.id === classId)
      if (term === '' || entry === undefined) {
        return failedRead('SEARCH_TERM_REQUIRED', t('schema.tree.needsTerm'))
      }
      try {
        const page = await client.operation('searchSchema', {
          params: { target: path },
          query: { q: term, kinds: entry.kinds, limit: CLASS_PAGE_LIMIT },
        })
        const refs = page.items.filter((ref) => ref.schema === schema)
        for (const ref of refs) known.current.set(refKey(ref), ref)
        const value = refs.map((ref) => ({
          name: ref.signature === null ? ref.name : `${ref.name}(${ref.signature})`,
          key: refKey(ref),
        }))
        const meta = { source: 'live' as const, observedAt: new Date().toISOString() }
        return page.nextCursor === null
          ? { state: 'ready', value, ...meta }
          : { state: 'partial', value, ...meta, missing: [t('schema.list.more')] }
      } catch (error) {
        const failure = classifyFailure(error)
        return failedRead(failure.code, failure.message)
      }
    },
    [client, path, term, classes],
  )
  const onSelect = (selection: SchemaTreeSelection): void => {
    if (selection.kind === 'object') {
      setSelected(known.current.get(selection.key))
      setPanel(DEFAULT_PANEL_STATE)
      setKind(undefined)
    } else if (selection.kind === 'class') {
      setSelected(undefined)
      setKind(selection.classId)
    } else {
      setSelected(undefined)
      setKind(undefined)
    }
  }
  const page = CLASS_PAGES.get(kind ?? '')
  return (
    <div className="flex flex-col gap-3" data-slot="schema-tree">
      <SearchForm
        applied={term}
        label={t('schema.tree.filter')}
        onApply={(next) => {
          setTerm(next.slice(0, SEARCH_MAX_LENGTH))
          setSelected(undefined)
        }}
      />
      <SchemaTree
        // A new filter is a new tree: every class reads again.
        key={term}
        schemas={schemas}
        loadObjects={load}
        classes={classes}
        aria-label={t('schema.tree.label')}
        onSelect={onSelect}
        onRetry={overview.refetch}
        onRefresh={overview.refetch}
        busy={overview.fetching}
        headingLevel={3}
      />
      {page === undefined ? null : (
        <Link href={`${targetHref(props.target, '/schema')}/${page}`} className="text-sm underline">
          {t('schema.tree.openKind')}
        </Link>
      )}
      {selected === undefined ? null : (
        <section
          aria-label={t('schema.object.what')}
          className="rounded-md border border-default p-4"
          data-slot="tree-object"
        >
          <ObjectDetail
            key={refKey(selected)}
            target={props.target}
            object={objectKeyOfRef(selected)}
            state={panel}
            onState={(next) => setPanel(next)}
          />
        </section>
      )}
    </div>
  )
}

/** The `/schema/<kind>` page of a tree class. */
const CLASS_PAGES: ReadonlyMap<string, string> = new Map([
  ['table', 'tables'],
  ['view', 'views'],
  ['materialized_view', 'materialized-views'],
  ['function', 'functions'],
  ['trigger', 'triggers'],
  ['index', 'indexes'],
  ['policy', 'policies'],
  ['sequence', 'sequences'],
  ['type', 'types'],
  ['extension', 'extensions'],
])

function mapSchemas(
  readable: ReturnType<typeof useSchemaOverview>['readable'],
): Readable<readonly SchemaTreeSchema[]> {
  switch (readable.state) {
    case 'loading':
    case 'failed':
      return readable
    case 'stale':
      return { ...readable, value: readable.value.schemas.map((entry) => ({ name: entry.name })) }
    case 'partial':
      return { ...readable, value: readable.value.schemas.map((entry) => ({ name: entry.name })) }
    case 'ready':
      return { ...readable, value: readable.value.schemas.map((entry) => ({ name: entry.name })) }
  }
}
