import {
  Badge,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import {
  CollapsibleCardSection,
  readableValue,
  UntrustedName,
  useResolvedNow,
} from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useId, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import {
  accountIndex,
  accountName,
  filterKeys,
  isKeyStateFilter,
  KEY_STATE_FILTERS,
  type KeyStateFilter,
  keyFlags,
  keyStateFilterLabel,
  keyStateLabel,
} from './api-keys-model.ts'
import { Field, NativeSelect } from './fields.tsx'
import { ACCESS_PAGE_LIMIT, apiKeysQuery } from './keys.ts'
import { ListView } from './list-view.tsx'
import { type ApiKey, type ServiceAccount, tiersLabel, utc } from './model.ts'
import { NoMatch } from './no-match.tsx'
import { targetChoicesQuery } from './scope-reads.ts'

/**
 * "All API keys" on the Service accounts page: every API key of every
 * service account in one table, so a key that is about to expire, was never
 * used or is no longer wanted can be found without opening each account.
 * There is deliberately no page of its own (information-architecture.md §2.1).
 * The section reads the keys when it is opened, not before. A key's secret is
 * never part of any read; this table cannot show one.
 *
 * "Never used" is said of a key whose read says it has no use recorded; a key
 * list that could not be read says that and nothing about use. A filter that
 * leaves no key is "No match", distinct from a list that holds no key.
 */
export function ApiKeysOverview({
  accounts,
}: {
  /** The service accounts as the page read them, to name the accounts; undefined when that read gave none. */
  readonly accounts: readonly ServiceAccount[] | undefined
}): ReactNode {
  return (
    <CollapsibleCardSection
      title={t('access.apiKeys.overview.title')}
      description={t('access.apiKeys.overview.description')}
    >
      <ApiKeysTable accounts={accounts} />
    </CollapsibleCardSection>
  )
}

function ApiKeysTable({
  accounts,
}: {
  readonly accounts: readonly ServiceAccount[] | undefined
}): ReactNode {
  const { client } = useApi()
  const filterId = useId()
  const [filter, setFilter] = useState<KeyStateFilter>('all')
  const now = useResolvedNow()
  const query = useQuery(apiKeysQuery(client))
  const readable = toReadable(query, {
    missing: (page) =>
      page.nextCursor === null
        ? undefined
        : [t('access.apiKeys.more', { count: ACCESS_PAGE_LIMIT })],
  })
  const names = accountIndex(accounts ?? [])
  // Paths are read only for a key limited to named targets; without them the IDs are shown.
  const limited = readableValue(readable)?.items.some(
    (key) => key.restrictions.targets.kind === 'list',
  )
  const targets = useQuery({ ...targetChoicesQuery(client), enabled: limited === true })
  const paths = new Map((targets.data?.items ?? []).map((target) => [target.id, target.path]))

  return (
    <ListView
      readable={readable}
      error={query.error}
      what={t('access.apiKeys.what')}
      permission="access.read"
      isEmpty={(page) => page.items.length === 0}
      emptyTitle={t('access.apiKeys.empty.title')}
      emptyDescription={t('access.apiKeys.empty.body')}
      onRetry={() => void query.refetch()}
      busy={query.isFetching}
    >
      {(page) => {
        if (page.items.length === 0) return null
        const rows = filterKeys(page.items, filter)
        return (
          <div className="flex flex-col gap-3" id="api-key-overview">
            <div className="max-w-xs">
              <Field id={filterId} label={t('access.apiKeys.filter')}>
                <NativeSelect
                  id={filterId}
                  value={filter}
                  options={KEY_STATE_FILTERS.map((value) => ({
                    value,
                    label: keyStateFilterLabel(value),
                  }))}
                  onChange={(event) => {
                    if (isKeyStateFilter(event.target.value)) setFilter(event.target.value)
                  }}
                />
              </Field>
            </div>
            {rows.length === 0 ? (
              <NoMatch onReset={() => setFilter('all')} />
            ) : (
              <>
                <p className="text-sm text-foreground-light">
                  {t('access.apiKeys.count', { shown: rows.length, total: page.items.length })}
                </p>
                <Table>
                  <TableCaption className="sr-only">{t('access.apiKeys.caption')}</TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">{t('access.apiKeys.column.account')}</TableHead>
                      <TableHead scope="col">{t('access.apiKeys.column.key')}</TableHead>
                      <TableHead scope="col">{t('access.apiKeys.column.scopes')}</TableHead>
                      <TableHead scope="col">{t('access.apiKeys.column.targets')}</TableHead>
                      <TableHead scope="col">{t('access.apiKeys.column.state')}</TableHead>
                      <TableHead scope="col">{t('access.apiKeys.column.lastUsed')}</TableHead>
                      <TableHead scope="col">{t('access.apiKeys.column.expires')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((key) => (
                      <KeyRow
                        key={key.id}
                        apiKey={key}
                        account={names.get(key.serviceAccountId)}
                        paths={paths}
                        nowMs={now}
                      />
                    ))}
                  </TableBody>
                </Table>
              </>
            )}
          </div>
        )
      }}
    </ListView>
  )
}

function KeyRow({
  apiKey,
  account,
  paths,
  nowMs,
}: {
  readonly apiKey: ApiKey
  readonly account: ServiceAccount | undefined
  readonly paths: ReadonlyMap<string, string>
  readonly nowMs: number
}): ReactNode {
  const flags = keyFlags(apiKey, nowMs)
  const targets = apiKey.restrictions.targets
  return (
    <TableRow data-api-key={apiKey.id} data-state={apiKey.state}>
      <TableCell>
        {account === undefined ? (
          <code className="font-mono text-xs">{apiKey.serviceAccountId}</code>
        ) : (
          <UntrustedName name={accountName(account)} label={t('access.apiKeys.account.name')} />
        )}
      </TableCell>
      <TableCell>
        <span className="flex flex-col gap-0.5">
          {apiKey.label === null ? null : (
            <UntrustedName name={apiKey.label} label={t('access.service.apiKey.name')} />
          )}
          <code className="font-mono text-xs text-foreground-lighter">{apiKey.id}</code>
        </span>
      </TableCell>
      <TableCell>
        <span className="font-mono text-xs">{apiKey.scopes.join(' ')}</span>
      </TableCell>
      <TableCell>
        <span className="flex flex-col gap-1 text-xs">
          <span>{tiersLabel(apiKey.restrictions.tiers)}</span>
          {targets.kind === 'all' ? (
            <span className="text-foreground-light">{t('access.apiKeys.targets.all')}</span>
          ) : (
            <details>
              <summary className="cursor-pointer text-foreground-light">
                {targets.targetIds.length === 1
                  ? t('access.apiKeys.targets.one')
                  : t('access.apiKeys.targets.many', { count: targets.targetIds.length })}
              </summary>
              <ul className="mt-1 flex flex-col gap-1">
                {targets.targetIds.map((id) => {
                  const path = paths.get(id)
                  return (
                    <li key={id} className="flex flex-col">
                      {path === undefined ? null : (
                        <UntrustedName name={path} mono label={t('access.apiKeys.target.path')} />
                      )}
                      <code className="font-mono text-foreground-lighter">{id}</code>
                    </li>
                  )
                })}
              </ul>
            </details>
          )}
        </span>
      </TableCell>
      <TableCell>
        <Badge
          variant={apiKey.state === 'active' ? 'success' : 'default'}
          data-state={apiKey.state}
        >
          {keyStateLabel(apiKey.state)}
        </Badge>
      </TableCell>
      <TableCell className="whitespace-nowrap">
        {apiKey.lastUsedAt === null ? (
          <span className="text-foreground-lighter">{t('access.apiKeys.neverUsed')}</span>
        ) : (
          utc(apiKey.lastUsedAt)
        )}
      </TableCell>
      <TableCell>
        <span className="flex flex-col items-start gap-1">
          <span className="whitespace-nowrap">{utc(apiKey.expiresAt)}</span>
          {flags.expiresSoon ? (
            <Badge variant="warning" data-flag="expires-soon">
              {t('access.apiKeys.badge.expiresSoon')}
            </Badge>
          ) : null}
          {flags.unused ? (
            <Badge variant="warning" data-flag="unused">
              {t('access.apiKeys.badge.unused')}
            </Badge>
          ) : null}
        </span>
      </TableCell>
    </TableRow>
  )
}
