import { Badge } from '@exponetdb/ui'
import {
  PageContainer,
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
  readableValue,
  UntrustedName,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { useMe } from '../../lib/session/guard.tsx'
import { holds } from './fields.tsx'
import { ACCESS_PAGE_LIMIT } from './keys.ts'
import { ListView } from './list-view.tsx'
import { bindingsQuery, identitiesQuery, rolesQuery } from './people-keys.ts'
import {
  type Identity,
  identityIndex,
  identityName,
  type Role,
  type RoleBinding,
} from './people-model.ts'
import { BindingRow } from './person-card.tsx'
import { type StatusLine, StatusLines, useStatusLine } from './status.tsx'

/**
 * `/access/roles`: the built-in role catalog (what each role is for and the
 * permissions it carries) and who holds each role at which scope. A binding is
 * removed through a plan (the review page opens); a new one is planned on the
 * People page. Role names and permissions are the server's catalog; people's
 * names are untrusted text.
 */
export function RolesPage(): ReactNode {
  const { client } = useApi()
  const me = useMe()
  const canManage = holds(me, 'access.manage')
  const line = useStatusLine()
  const Link = useLinkComponent()
  const roles = useQuery(rolesQuery(client))
  const bindings = useQuery(bindingsQuery(client))
  const identities = useQuery(identitiesQuery(client))
  // The catalog is fixed per release: an older read is not stale in any way that matters.
  const readable = toReadable(roles, { staleAfterMs: 24 * 60 * 60_000 })
  const bindingRead = toReadable(bindings, {
    missing: (page) =>
      page.nextCursor === null
        ? undefined
        : [t('roles.bindings.more', { count: ACCESS_PAGE_LIMIT })],
  })
  const people = readableValue(toReadable(identities))
  const index = identityIndex(people?.items ?? [])

  return (
    <>
      <PageHeader>
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{t('roles.title')}</PageHeaderTitle>
            <PageHeaderDescription>{t('roles.description')}</PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer>
        <div className="flex flex-col gap-2 pt-6">
          <p className="text-sm text-foreground-light">
            {t('roles.bindHint')}{' '}
            <Link href="/access/people" className="text-foreground underline">
              {t('roles.bindHint.link')}
            </Link>
          </p>
          <StatusLines line={line} />
        </div>
        <section aria-label={t('roles.list')} className="flex flex-col gap-4 pt-8 pb-12">
          <ListView
            readable={readable}
            error={roles.error}
            what={t('roles.what')}
            permission="access.read"
            isEmpty={(value) => value.items.length === 0}
            emptyTitle={t('roles.empty.title')}
            emptyDescription={t('roles.empty.body')}
            onRetry={() => void roles.refetch()}
            busy={roles.isFetching}
          >
            {(value) => (
              <div className="flex flex-col gap-4">
                <ListView
                  readable={bindingRead}
                  error={bindings.error}
                  what={t('roles.bindings.what')}
                  permission="access.read"
                  isEmpty={() => false}
                  emptyTitle=""
                  emptyDescription=""
                  onRetry={() => void bindings.refetch()}
                  busy={bindings.isFetching}
                >
                  {() => null}
                </ListView>
                <ul id="role-list" className="cards flex flex-col gap-4">
                  {value.items.map((role) => (
                    <RoleCard
                      key={role.id}
                      role={role}
                      bindings={readableValue(bindingRead)?.items.filter(
                        (binding) => binding.roleId === role.id && binding.state === 'active',
                      )}
                      index={index}
                      line={line}
                      canManage={canManage}
                    />
                  ))}
                </ul>
              </div>
            )}
          </ListView>
        </section>
      </PageContainer>
    </>
  )
}

function RoleCard({
  role,
  bindings,
  index,
  line,
  canManage,
}: {
  readonly role: Role
  readonly bindings: readonly RoleBinding[] | undefined
  readonly index: ReadonlyMap<string, Identity>
  readonly line: StatusLine
  readonly canManage: boolean
}): ReactNode {
  return (
    <li
      className="card flex flex-col gap-3 rounded-lg border border-default bg-surface-100 p-5"
      data-role={role.id}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-medium text-foreground">{role.title}</h2>
        <code className="font-mono text-xs text-foreground-light">{role.id}</code>
      </div>
      <p className="text-sm text-foreground-light">{role.intendedFor}</p>
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium text-foreground">{t('roles.permissions')}</h3>
        <ul className="flex flex-wrap gap-1.5" aria-label={t('roles.permissions')}>
          {role.permissions.map((permission) => (
            <li key={permission}>
              <Badge className="font-mono">{permission}</Badge>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium text-foreground">{t('roles.holders')}</h3>
        {bindings === undefined ? (
          <p className="text-sm text-foreground-lighter">{t('roles.holders.unknown')}</p>
        ) : bindings.length === 0 ? (
          <p className="text-sm text-foreground-lighter">{t('roles.holders.none')}</p>
        ) : (
          <ul className="bindings flex flex-col gap-1">
            {bindings.map((binding) => {
              const person = index.get(binding.identityId)
              return (
                <BindingRow
                  key={binding.id}
                  binding={binding}
                  line={line}
                  canManage={canManage}
                  who={
                    person === undefined ? (
                      <code className="font-mono text-xs">{binding.identityId}</code>
                    ) : (
                      <UntrustedName name={identityName(person)} label={t('people.name')} />
                    )
                  }
                />
              )
            })}
          </ul>
        )}
      </div>
    </li>
  )
}
