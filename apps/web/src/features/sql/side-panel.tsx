import type { QueryHistoryEntry, SavedQuery } from '@exponetdb/sdk/operations'
import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from '@exponetdb/ui'
import {
  ConfirmDialog,
  formatCount,
  ObservedTime,
  type Readable,
  ReadableView,
  UntrustedName,
  UntrustedText,
} from '@exponetdb/ui-patterns'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useId, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { withReauth } from '../../lib/api/reauth.ts'
import { describeError, t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { actionError } from '../plans/failure.ts'
import { nounPhrase } from '../target/phrases.ts'
import { historyQuery, savedQuery, sqlKeys } from './keys.ts'
import { SaveDialog, type SaveInput } from './save-dialog.tsx'
import { RenameDialog, type SavedChange, SavedMenu, useSavedChanges } from './saved-menu.tsx'
import { copyName } from './sql-model.ts'
import { DRAFT_TEMPLATES, QUERY_TEMPLATES, type SqlTemplate } from './templates.ts'

/**
 * The side of the workspace (Studio's SQL editor sidebar): the saved queries
 * of this target and its project, the person's own read history of this
 * target from the audit, and a few templates. Opening an entry opens its text
 * in a new tab and never runs it.
 */
interface Paged<T> {
  readonly items: readonly T[]
  readonly hasMore: boolean
}

function usePaged<T>(
  query: ReturnType<typeof useInfiniteQuery<{ items: readonly T[]; nextCursor: string | null }>>,
): { readable: Readable<Paged<T>>; refetch: () => void; busy: boolean; more: () => void } {
  const data = query.data
  const value =
    data === undefined
      ? undefined
      : {
          items: data.pages.flatMap((page) => page.items),
          hasMore: data.pages[data.pages.length - 1]?.nextCursor != null,
        }
  return {
    readable: toReadable(
      {
        data: value,
        error: query.error,
        isError: query.isError,
        dataUpdatedAt: query.dataUpdatedAt,
      },
      { staleAfterMs: 5 * 60_000 },
    ),
    refetch: () => void query.refetch(),
    busy: query.isFetching,
    more: () => void query.fetchNextPage(),
  }
}

type SideTab = 'saved' | 'history' | 'templates'

function sideTabOf(value: string): SideTab {
  return value === 'history' || value === 'templates' ? value : 'saved'
}

export function SidePanel(props: {
  readonly path: string
  readonly projectId: string
  readonly onOpenText: (sql: string, origin: 'history') => void
  readonly onOpenSaved: (saved: SavedQuery) => void
  readonly onOpenTemplate: (template: SqlTemplate) => void
  /** A rename or a change of visibility was made; open tabs holding the query follow. */
  readonly onSavedChanged: (change: SavedChange) => void
}): ReactNode {
  const [tab, setTab] = useState<SideTab>('saved')
  return (
    <aside
      aria-label={t('sql.side.label')}
      className="flex min-w-0 flex-col gap-3"
      data-block="sql-side"
    >
      <Tabs value={tab} onValueChange={(next) => setTab(sideTabOf(next))}>
        <TabsList>
          <TabsTrigger value="saved">{t('sql.saved.title')}</TabsTrigger>
          <TabsTrigger value="history">{t('sql.history.title')}</TabsTrigger>
          <TabsTrigger value="templates">{t('sql.templates.title')}</TabsTrigger>
        </TabsList>
        <TabsContent value="saved" className="pt-3">
          <SavedList
            path={props.path}
            projectId={props.projectId}
            onOpen={props.onOpenSaved}
            onChanged={props.onSavedChanged}
          />
        </TabsContent>
        <TabsContent value="history" className="pt-3">
          <HistoryList path={props.path} onOpen={(sql) => props.onOpenText(sql, 'history')} />
        </TabsContent>
        <TabsContent value="templates" className="pt-3">
          <TemplatesList onOpen={props.onOpenTemplate} />
        </TabsContent>
      </Tabs>
    </aside>
  )
}

function HistoryList(props: {
  readonly path: string
  readonly onOpen: (sql: string) => void
}): ReactNode {
  const { client } = useApi()
  const query = useInfiniteQuery(historyQuery(client, props.path))
  const read = usePaged<QueryHistoryEntry>(query)
  return (
    <div className="flex flex-col gap-2" data-block="sql-history">
      <p className="text-xs text-foreground-lighter">{t('sql.history.note')}</p>
      <ReadableView
        readable={read.readable}
        what={nounPhrase('sql.history.what')}
        onRetry={read.refetch}
        onRefresh={read.refetch}
        busy={read.busy}
        headingLevel={3}
        empty={{ isEmpty: (value) => value.items.length === 0 }}
        ready={(value) => (
          <div className="flex flex-col gap-2">
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {value.items.map((entry) => (
                <HistoryItem key={entry.queryId} entry={entry} onOpen={props.onOpen} />
              ))}
            </ul>
            {value.hasMore ? (
              <Button variant="outline" size="tiny" onClick={read.more} disabled={read.busy}>
                {t('sql.list.more')}
              </Button>
            ) : null}
          </div>
        )}
      />
    </div>
  )
}

function HistoryItem(props: {
  readonly entry: QueryHistoryEntry
  readonly onOpen: (sql: string) => void
}): ReactNode {
  const { entry } = props
  const facts = [
    entry.kind === 'explain' ? t('sql.history.explain') : t('sql.history.query'),
    entry.outcome === 'succeeded' ? t('sql.history.succeeded') : t('sql.history.failed'),
    entry.rows === null ? null : t('sql.history.rows', { rows: formatCount(entry.rows) }),
    entry.durationMs === null ? null : t('sql.history.ms', { ms: formatCount(entry.durationMs) }),
    entry.truncated === true ? t('sql.history.truncated') : null,
    entry.errorCode === null ? null : entry.errorCode,
    t('sql.history.client', { client: entry.client, caller: entry.callerClass }),
  ].filter((fact): fact is string => fact !== null)
  return (
    <li
      className="flex flex-col gap-1 rounded-md border border-default p-2 text-sm"
      data-history={entry.queryId}
    >
      <div className="flex flex-wrap items-center gap-x-2 text-xs text-foreground-light">
        <ObservedTime observedAt={entry.occurredAt} />
        <span>{facts.join(' · ')}</span>
      </div>
      <UntrustedText
        text={entry.statement}
        mono
        maxLines={4}
        maxCodePoints={256}
        label={t('sql.history.statement')}
        className="text-xs"
      />
      <div>
        <Button variant="outline" size="tiny" onClick={() => props.onOpen(entry.statement)}>
          {t('sql.history.open')}
        </Button>
      </div>
    </li>
  )
}

function SavedList(props: {
  readonly path: string
  readonly projectId: string
  readonly onOpen: (saved: SavedQuery) => void
  readonly onChanged: (change: SavedChange) => void
}): ReactNode {
  const { client } = useApi()
  const query = useInfiniteQuery(savedQuery(client, props.path))
  const read = usePaged<SavedQuery>(query)
  return (
    <div className="flex flex-col gap-2" data-block="sql-saved">
      <ReadableView
        readable={read.readable}
        what={nounPhrase('sql.saved.what')}
        onRetry={read.refetch}
        onRefresh={read.refetch}
        busy={read.busy}
        headingLevel={3}
        empty={{ isEmpty: (value) => value.items.length === 0 }}
        ready={(value) => (
          <div className="flex flex-col gap-2">
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {value.items.map((saved) => (
                <SavedItem
                  key={saved.id}
                  saved={saved}
                  path={props.path}
                  projectId={props.projectId}
                  onOpen={props.onOpen}
                  onChanged={props.onChanged}
                />
              ))}
            </ul>
            {value.hasMore ? (
              <Button variant="outline" size="tiny" onClick={read.more} disabled={read.busy}>
                {t('sql.list.more')}
              </Button>
            ) : null}
          </div>
        )}
      />
    </div>
  )
}

type ItemNote =
  | { readonly kind: 'done'; readonly text: string }
  | { readonly kind: 'failed'; readonly text: string }

function SavedItem(props: {
  readonly saved: SavedQuery
  readonly path: string
  readonly projectId: string
  readonly onOpen: (saved: SavedQuery) => void
  readonly onChanged: (change: SavedChange) => void
}): ReactNode {
  const { client, confirmIdentity } = useApi()
  const queryClient = useQueryClient()
  const changes = useSavedChanges(props.path)
  const nameId = useId()
  const [dialog, setDialog] = useState<'rename' | 'copy' | undefined>(undefined)
  const [note, setNote] = useState<ItemNote | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const { saved } = props
  const changeVisibility = async (visibility: SavedQuery['visibility']): Promise<void> => {
    if (visibility === saved.visibility || busy) return
    setBusy(true)
    setNote(undefined)
    try {
      const change = await changes.setVisibility(saved.id, visibility)
      props.onChanged(change)
      setNote({
        kind: 'done',
        text:
          change.after.visibility === 'personal'
            ? t('sql.saved.nowPersonal', { revision: change.after.revision })
            : t('sql.saved.nowShared', { revision: change.after.revision }),
      })
    } catch (error) {
      setNote({ kind: 'failed', text: describeError(error) })
    } finally {
      setBusy(false)
    }
  }
  const saveCopy = async (input: SaveInput): Promise<SavedQuery> => {
    try {
      const copy = await withReauth(client, confirmIdentity, () =>
        client.operation('createSavedQuery', {
          body: {
            name: input.name,
            sql: saved.sql,
            visibility: input.visibility,
            scope:
              input.scope === 'target'
                ? { kind: 'target', target: props.path }
                : { kind: 'project', projectId: props.projectId },
          },
        }),
      )
      await queryClient.invalidateQueries({ queryKey: sqlKeys.saved(props.path) })
      setNote({ kind: 'done', text: t('sql.saved.copySaved') })
      return copy
    } catch (error) {
      throw actionError(error)
    }
  }
  const remove = async (): Promise<void> => {
    try {
      await withReauth(client, confirmIdentity, () =>
        client.operation('deleteSavedQuery', { params: { savedQueryId: saved.id } }),
      )
      await queryClient.invalidateQueries({ queryKey: sqlKeys.saved(props.path) })
    } catch (error) {
      throw actionError(error)
    }
  }
  return (
    <li
      className="flex flex-col gap-1 rounded-md border border-default p-2 text-sm"
      data-saved={saved.id}
    >
      <span id={nameId}>
        <UntrustedName
          name={saved.name}
          maxCodePoints={120}
          label={t('sql.saved.name')}
          className="font-medium"
        />
      </span>
      <p className="m-0 text-xs text-foreground-light">
        {[
          saved.visibility === 'project' ? t('sql.saved.project') : t('sql.saved.personal'),
          saved.scope.kind === 'target' ? t('sql.saved.scopeTarget') : t('sql.saved.scopeProject'),
          saved.ownedByCaller ? t('sql.saved.yours') : t('sql.saved.someoneElse'),
          t('sql.saved.revision', { revision: saved.revision }),
        ].join(' · ')}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="tiny" onClick={() => props.onOpen(saved)}>
          {t('sql.saved.open')}
        </Button>
        {saved.ownedByCaller ? (
          <ConfirmDialog
            trigger={
              <Button variant="outline" size="tiny">
                {t('sql.saved.delete')}
              </Button>
            }
            title={t('sql.saved.deleteTitle')}
            description={
              <span className="flex flex-col gap-2">
                <span>{t('sql.saved.deleteBody')}</span>
                <UntrustedName name={saved.name} maxCodePoints={120} label={t('sql.saved.name')} />
              </span>
            }
            actionLabel={t('sql.saved.deleteAction')}
            destructive
            onConfirm={remove}
          />
        ) : null}
        {saved.ownedByCaller ? (
          <SavedMenu
            label={t('sql.saved.menu')}
            describedBy={nameId}
            visibility={saved.visibility}
            busy={busy}
            onRename={() => setDialog('rename')}
            onVisibility={(visibility) => void changeVisibility(visibility)}
            onCopy={() => setDialog('copy')}
          />
        ) : null}
      </div>
      {note === undefined ? null : (
        <p
          role={note.kind === 'failed' ? 'alert' : 'status'}
          className="m-0 text-xs"
          data-saved-note={note.kind}
        >
          {note.kind === 'failed' ? `${t('sql.saved.changeFailedTitle')}: ${note.text}` : note.text}
        </p>
      )}
      {dialog === 'rename' ? (
        <RenameDialog
          open
          onOpenChange={(open) => setDialog(open ? 'rename' : undefined)}
          initialName={saved.name}
          onRename={async (name) => {
            const change = await changes.rename(saved.id, name)
            props.onChanged(change)
            setNote({
              kind: 'done',
              text: t('sql.saved.renamed', { revision: change.after.revision }),
            })
          }}
        />
      ) : null}
      {dialog === 'copy' ? (
        <SaveDialog
          open
          variant="copy"
          onOpenChange={(open) => setDialog(open ? 'copy' : undefined)}
          initialName={copyName(saved.name, (name) => t('sql.saved.copyName', { name }))}
          initialVisibility={saved.visibility}
          initialScope={saved.scope.kind}
          onSave={saveCopy}
        />
      ) : null}
    </li>
  )
}

function TemplatesList(props: { readonly onOpen: (template: SqlTemplate) => void }): ReactNode {
  return (
    <div className="flex flex-col gap-3" data-block="sql-templates">
      <p className="text-xs text-foreground-lighter">{t('sql.templates.note')}</p>
      <TemplateGroup
        heading={t('sql.templates.queryGroup')}
        templates={QUERY_TEMPLATES}
        onOpen={props.onOpen}
      />
      <TemplateGroup
        heading={t('sql.templates.draftGroup')}
        templates={DRAFT_TEMPLATES}
        onOpen={props.onOpen}
      />
    </div>
  )
}

function TemplateGroup(props: {
  readonly heading: string
  readonly templates: readonly SqlTemplate[]
  readonly onOpen: (template: SqlTemplate) => void
}): ReactNode {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="m-0 text-xs font-medium">
        {props.heading}
      </h3>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {props.templates.map((template) => (
          <TemplateItem key={template.id} template={template} onOpen={props.onOpen} />
        ))}
      </ul>
    </section>
  )
}

function TemplateItem(props: {
  readonly template: SqlTemplate
  readonly onOpen: (template: SqlTemplate) => void
}): ReactNode {
  const { template } = props
  const titleId = useId()
  return (
    <li
      className="flex flex-col gap-1 rounded-md border border-default p-2 text-sm"
      data-template={template.id}
      data-template-mode={template.mode}
    >
      <span id={titleId} className="font-medium">
        {t(template.titleKey)}
      </span>
      <p className="m-0 text-xs text-foreground-light">{t(template.descriptionKey)}</p>
      <div>
        <Button
          variant="outline"
          size="tiny"
          aria-describedby={titleId}
          onClick={() => props.onOpen(template)}
        >
          {t('sql.templates.open')}
        </Button>
      </div>
    </li>
  )
}
