import type { SchemaObject } from '@exponetdb/sdk/operations'
import { Button, copyToClipboard } from '@exponetdb/ui'
import { useLinkComponent } from '@exponetdb/ui-patterns'
import { type ReactNode, useState } from 'react'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import type { TargetRoute } from '../target/params.ts'
import { queryTableSql } from './browse-sql.ts'
import { draftHref, LINK_MAX_CHARS, sqlHref } from './links.ts'
import { isBrowsableKind, objectKeyOfRef, qualifiedName } from './schema-model.ts'
import { objectHref, type PanelState, withPanelState } from './search.ts'

type CopyState = 'idle' | 'name' | 'link' | 'failed'

const QUERY_LABEL: Readonly<Record<string, MessageKey>> = {
  table: 'schema.actions.queryTable',
  view: 'schema.actions.queryView',
  materialized_view: 'schema.actions.queryMaterializedView',
}

/** The kinds whose definition is a statement that changes the schema: it opens as a draft, not as a query. */
const DRAFT_DEFINITION_KINDS: ReadonlySet<string> = new Set(['function', 'procedure', 'trigger'])

/**
 * The actions on one object, none of which changes anything: copy its quoted
 * qualified name, copy a link to it (the object, the tab and the row
 * browser's sort and filters, never a name in the path), query it, open its
 * definition in the SQL editor, and start a draft. The links to the SQL page
 * open text in a new tab; nothing runs until the person presses Run there.
 */
export function ObjectActions(props: {
  readonly target: TargetRoute
  readonly object: SchemaObject
  readonly state: PanelState
}): ReactNode {
  const Link = useLinkComponent()
  const [copied, setCopied] = useState<CopyState>('idle')
  const { target, object } = props
  const key = objectKeyOfRef(object.ref)
  const name = qualifiedName(key)
  const link = objectHref(target, key, withPanelState({}, props.state))
  const queryLabel = QUERY_LABEL[object.ref.kind]
  const query =
    queryLabel === undefined || !isBrowsableKind(object.ref.kind)
      ? undefined
      : sqlHref(target, queryTableSql(object.ref.schema, object.ref.name) ?? '')
  const definition = object.definition
  const definitionHref =
    definition === null
      ? undefined
      : sqlHref(target, definition, DRAFT_DEFINITION_KINDS.has(object.ref.kind) ? 'draft' : 'query')
  const tooLongBy =
    definition !== null && definition.length > LINK_MAX_CHARS ? definition.length : undefined

  const copy = async (what: 'name' | 'link', text: string | undefined): Promise<void> => {
    if (text === undefined) return
    setCopied((await copyToClipboard(text)) ? what : 'failed')
  }

  return (
    <div className="flex flex-col gap-2" data-slot="object-actions">
      <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0">
        <legend className="sr-only">{t('schema.actions.label')}</legend>
        <Button
          type="button"
          size="tiny"
          variant="outline"
          disabled={name === undefined}
          onClick={() => void copy('name', name)}
        >
          {t('schema.actions.copyName')}
        </Button>
        {link === undefined ? null : (
          <Button
            type="button"
            size="tiny"
            variant="outline"
            onClick={() => void copy('link', `${window.location.origin}${link}`)}
          >
            {t('schema.actions.copyLink')}
          </Button>
        )}
        {query === undefined || queryLabel === undefined ? null : (
          <Link href={query} className="text-sm underline">
            {t(queryLabel)}
          </Link>
        )}
        {definitionHref === undefined ? null : (
          <Link href={definitionHref} className="text-sm underline">
            {t('schema.actions.openDefinition')}
          </Link>
        )}
        <Link href={draftHref(target)} className="text-sm underline">
          {t('schema.actions.draft')}
        </Link>
      </fieldset>
      <p role="status" className="min-h-4 text-xs text-foreground-light">
        {copied === 'name'
          ? t('schema.actions.copiedName')
          : copied === 'link'
            ? t('schema.actions.copiedLink')
            : copied === 'failed'
              ? t('schema.actions.copyFailed')
              : ''}
      </p>
      {tooLongBy === undefined ? null : (
        <p role="note" className="text-xs text-foreground-light" data-slot="definition-too-long">
          {t('schema.actions.definitionTooLong', { length: tooLongBy, max: LINK_MAX_CHARS })}
        </p>
      )}
      <p className="text-xs text-foreground-light">{t('schema.actions.note')}</p>
    </div>
  )
}
