import type { OperationRead } from '@exponetdb/sdk/operations'
import {
  Button,
  cn,
  Input,
  inputVariants,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import {
  EmptyState,
  ObservedTime,
  PageContainer,
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
  ReadableView,
  UntrustedName,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import { useInfiniteQuery } from '@tanstack/react-query'
import { type ReactNode, useId, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { operationListQuery } from './keys.ts'
import {
  APPLY_TEXT,
  isFiltered,
  isKindFilter,
  KIND_MAX_LENGTH,
  OPERATION_STATES,
  type OperationsSearch,
  operationPath,
  STATE_TEXT,
  VERIFICATION_TEXT,
} from './model.ts'
import { ActorText, OutcomeWords, StateText, TargetText } from './operation-page.tsx'

interface OperationList {
  readonly items: readonly OperationRead[]
  readonly nextCursor: string | null
}

const SELECT = cn(inputVariants({ size: 'small' }), 'w-auto')

/**
 * The operations the person may read (`/changes/operations`), newest first:
 * filters by state, kind and actor kept in the URL (validated by the route),
 * cursor paging with "Show more", and per row the kind, the target with its
 * tier, the state, the apply outcome and the verification outcome as two
 * separate words (applied is not verified), the creation and last change
 * with their age, and who started it. A failed read is an error, never an
 * empty list; "no operations" is said only after a successful read.
 */
export function OperationsPage(props: {
  readonly search: OperationsSearch
  readonly onSearch: (next: OperationsSearch) => void
}): ReactNode {
  const { client } = useApi()
  const query = useInfiniteQuery(operationListQuery(client, props.search))
  const pages = query.data?.pages
  const list: OperationList | undefined =
    pages === undefined
      ? undefined
      : {
          items: pages.flatMap((page) => page.items),
          nextCursor: pages.at(-1)?.nextCursor ?? null,
        }
  const readable = toReadable({
    data: list,
    error: query.error,
    isError: query.isError,
    dataUpdatedAt: query.dataUpdatedAt,
  })
  const filtered = isFiltered(props.search)
  return (
    <>
      <PageHeader size="large">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{t('changes.operations.title')}</PageHeaderTitle>
            <PageHeaderDescription>{t('changes.operations.description')}</PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="large" className="flex flex-col gap-4 py-6">
        <Toolbar search={props.search} onSearch={props.onSearch} />
        <ReadableView
          readable={readable}
          what={t('changes.operations.what')}
          onRetry={() => void query.refetch()}
          onRefresh={() => void query.refetch()}
          busy={query.isFetching}
          headingLevel={2}
          empty={{
            isEmpty: (value) => value.items.length === 0,
            content: (
              <EmptyState
                title={
                  filtered
                    ? t('changes.operations.noMatch.title')
                    : t('changes.operations.empty.title')
                }
                description={
                  filtered
                    ? t('changes.operations.noMatch.body')
                    : t('changes.operations.empty.body')
                }
                headingLevel={2}
              >
                {filtered ? (
                  <Button
                    type="button"
                    size="small"
                    variant="outline"
                    onClick={() => props.onSearch({})}
                  >
                    {t('changes.filter.clear')}
                  </Button>
                ) : null}
              </EmptyState>
            ),
          }}
          ready={(value) => (
            <div className="flex flex-col gap-3">
              <OperationTable operations={value.items} />
              {value.nextCursor === null ? (
                <p className="text-xs text-foreground-light">
                  {t('changes.operations.all', { count: value.items.length })}
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    size="small"
                    variant="default"
                    loading={query.isFetchingNextPage}
                    disabled={query.isFetchingNextPage}
                    onClick={() => void query.fetchNextPage()}
                  >
                    {t('changes.operations.more')}
                  </Button>
                  <span className="text-xs text-foreground-light">
                    {t('changes.operations.shown', { count: value.items.length })}
                  </span>
                </div>
              )}
              {query.isFetchNextPageError ? (
                <p role="alert" className="text-sm text-destructive">
                  {t('changes.operations.moreFailed')}
                </p>
              ) : null}
            </div>
          )}
        />
      </PageContainer>
    </>
  )
}

function Toolbar(props: {
  readonly search: OperationsSearch
  readonly onSearch: (next: OperationsSearch) => void
}): ReactNode {
  const { search, onSearch } = props
  const ids = useId()
  const [kind, setKind] = useState(search.kind ?? '')
  const kindInvalid = kind !== '' && !isKindFilter(kind)
  const change = (next: Partial<OperationsSearch>) => onSearch({ ...search, ...next })
  return (
    <search className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor={`${ids}-state`} className="text-xs text-foreground-light">
          {t('changes.filter.state')}
        </label>
        <select
          id={`${ids}-state`}
          className={SELECT}
          value={search.state ?? ''}
          onChange={(event) =>
            change({ state: OPERATION_STATES.find((state) => state === event.target.value) })
          }
        >
          <option value="">{t('changes.filter.state.all')}</option>
          {OPERATION_STATES.map((state) => {
            const key = STATE_TEXT[state]
            return (
              <option key={state} value={state}>
                {key === undefined ? state : t(key)}
              </option>
            )
          })}
        </select>
      </div>
      <form
        className="flex flex-col gap-1"
        onSubmit={(event) => {
          event.preventDefault()
          if (kindInvalid) return
          change({ kind: kind === '' ? undefined : kind })
        }}
      >
        <label htmlFor={`${ids}-kind`} className="text-xs text-foreground-light">
          {t('changes.filter.kind')}
        </label>
        <div className="flex items-center gap-2">
          <Input
            id={`${ids}-kind`}
            className="w-56 font-mono"
            value={kind}
            maxLength={KIND_MAX_LENGTH}
            placeholder="migration.apply"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={kindInvalid}
            aria-describedby={kindInvalid ? `${ids}-kind-error` : undefined}
            onChange={(event) => setKind(event.target.value)}
          />
          <Button type="submit" size="small" variant="outline" disabled={kindInvalid}>
            {t('changes.filter.kind.apply')}
          </Button>
        </div>
        {kindInvalid ? (
          <span id={`${ids}-kind-error`} className="text-xs text-destructive">
            {t('changes.filter.kind.invalid')}
          </span>
        ) : null}
      </form>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${ids}-actor`} className="text-xs text-foreground-light">
          {t('changes.filter.actor')}
        </label>
        <select
          id={`${ids}-actor`}
          className={SELECT}
          value={search.actor ?? 'any'}
          onChange={(event) =>
            change({ actor: event.target.value === 'self' ? 'self' : undefined })
          }
        >
          <option value="any">{t('changes.filter.actor.any')}</option>
          <option value="self">{t('changes.filter.actor.self')}</option>
        </select>
      </div>
      {isFiltered(search) ? (
        <Button
          type="button"
          size="small"
          variant="outline"
          onClick={() => {
            setKind('')
            onSearch({})
          }}
        >
          {t('changes.filter.clear')}
        </Button>
      ) : null}
    </search>
  )
}

function OperationTable({
  operations,
}: {
  readonly operations: readonly OperationRead[]
}): ReactNode {
  const Link = useLinkComponent()
  return (
    <Table>
      <TableCaption className="sr-only">{t('changes.operations.caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t('changes.column.operation')}</TableHead>
          <TableHead scope="col">{t('changes.column.kind')}</TableHead>
          <TableHead scope="col">{t('changes.column.target')}</TableHead>
          <TableHead scope="col">{t('changes.column.state')}</TableHead>
          <TableHead scope="col">{t('changes.column.apply')}</TableHead>
          <TableHead scope="col">{t('changes.column.verification')}</TableHead>
          <TableHead scope="col">{t('changes.column.created')}</TableHead>
          <TableHead scope="col">{t('changes.column.updated')}</TableHead>
          <TableHead scope="col">{t('changes.column.actor')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {operations.map((operation) => {
          const href = operationPath(operation.id)
          return (
            <TableRow
              key={operation.id}
              data-operation={operation.id}
              data-state={operation.state}
              data-tier={operation.subject.tier ?? 'unknown'}
            >
              <TableCell className="font-mono text-xs">
                {href === undefined ? (
                  <UntrustedName name={operation.id} mono label={t('changes.column.operation')} />
                ) : (
                  <Link href={href} className="text-primary underline focus-ring">
                    {operation.id}
                  </Link>
                )}
              </TableCell>
              <TableCell>
                <UntrustedName name={operation.kind} mono label={t('changes.column.kind')} />
              </TableCell>
              <TableCell>
                <TargetText subject={operation.subject} />
              </TableCell>
              <TableCell>
                <StateText state={operation.state} />
              </TableCell>
              <TableCell>
                <OutcomeWords table={APPLY_TEXT} value={operation.applyOutcome} name="apply" />
              </TableCell>
              <TableCell>
                <OutcomeWords
                  table={VERIFICATION_TEXT}
                  value={operation.verificationOutcome}
                  name="verification"
                />
              </TableCell>
              <TableCell>
                <ObservedTime observedAt={operation.createdAt} />
              </TableCell>
              <TableCell>
                <ObservedTime observedAt={operation.updatedAt} />
              </TableCell>
              <TableCell>
                <ActorText actor={operation.actor} clientName={null} />
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
