import { Button, Input } from '@exponetdb/ui'
import {
  Admonition,
  PageContainer,
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
  PageSection,
  PageSectionContent,
  PageSectionDescription,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
  readableValue,
  UntrustedName,
} from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useId, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { describeError, t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { useMe } from '../../lib/session/guard.tsx'
import { BindingForm } from './binding-form.tsx'
import { Field, holds, NativeSelect } from './fields.tsx'
import { InvitationLink, type RevealedInvitation } from './invitation-link.tsx'
import { InviteForm } from './invite-form.tsx'
import { ACCESS_PAGE_LIMIT } from './keys.ts'
import { ListView } from './list-view.tsx'
import { NoMatch } from './no-match.tsx'
import { bindingsQuery, type IdentityStateFilter, identitiesQuery } from './people-keys.ts'
import { bindingsOf, identityMatches, identityStateLabel } from './people-model.ts'
import { PersonCard } from './person-card.tsx'
import { StatusLines, useStatusLine } from './status.tsx'

const STATE_FILTERS: readonly IdentityStateFilter[] = [
  'all',
  'invited',
  'active',
  'disabled',
  'erased',
]

function isStateFilter(value: string): value is IdentityStateFilter {
  return (STATE_FILTERS as readonly string[]).includes(value)
}

function stateFilterLabel(filter: IdentityStateFilter): string {
  return filter === 'all' ? t('people.filter.state.all') : identityStateLabel(filter)
}

/**
 * `/access/people`: the people of the installation (identities of kind
 * `human`; service accounts have their own page) with their role bindings,
 * the invitation of a new person and what an administrator can do to one.
 * Reading needs `access.read`; every change needs `access.manage`, and the
 * server decides each again. An invitation link is held in this page's state
 * only, shown once in the person's card.
 *
 * The list can be limited to a state (the API's filter) and searched by name,
 * address or ID (in the page: the read is unchanged). A filter that leaves
 * nobody is "No match" with a way back, never the empty state of a list that
 * was read and holds nobody. After an invitation the page offers to assign a
 * role to the new person, which opens the same binding form as their card.
 */
export function PeoplePage(): ReactNode {
  const { client } = useApi()
  const me = useMe()
  const canManage = holds(me, 'access.manage')
  const line = useStatusLine()
  const searchId = useId()
  const stateId = useId()
  const [revealed, setRevealed] = useState<RevealedInvitation | null>(null)
  const [assigning, setAssigning] = useState<RevealedInvitation | null>(null)
  const [text, setText] = useState('')
  const [state, setState] = useState<IdentityStateFilter>('all')
  const identities = useQuery(identitiesQuery(client, state))
  const bindings = useQuery(bindingsQuery(client))
  const readable = toReadable(identities, {
    missing: (page) =>
      page.nextCursor === null ? undefined : [t('people.more', { count: ACCESS_PAGE_LIMIT })],
  })
  const bindingValue = readableValue(toReadable(bindings))
  const filtering = text.trim() !== '' || state !== 'all'
  const reset = (): void => {
    setText('')
    setState('all')
  }

  return (
    <>
      <PageHeader>
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{t('people.title')}</PageHeaderTitle>
            <PageHeaderDescription>{t('people.description')}</PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer>
        <div className="flex flex-col gap-4 pt-6">
          {bindings.isError && bindingValue === undefined ? (
            <Admonition
              type="warning"
              title={t('people.bindings.failed.title')}
              description={t('people.bindings.failed.body', {
                reason: describeError(bindings.error),
              })}
            />
          ) : null}
          {bindingValue !== undefined && bindingValue.nextCursor !== null ? (
            <Admonition
              type="warning"
              title={t('people.bindings.partial.title')}
              description={t('people.bindings.partial.body', { count: ACCESS_PAGE_LIMIT })}
            />
          ) : null}
          <StatusLines line={line} />
          {revealed === null ? null : (
            <InvitationLink
              revealed={revealed}
              onHide={() => setRevealed(null)}
              onAssign={canManage ? setAssigning : undefined}
            />
          )}
          {assigning === null ? null : (
            <section
              id="assign-role"
              aria-label={t('people.assign.region')}
              className="flex flex-col gap-3 rounded-md border border-default p-4"
            >
              <h2 className="text-sm font-medium text-foreground">
                {t('people.assign.title')}{' '}
                <UntrustedName name={assigning.who} label={t('people.name')} />
              </h2>
              <p className="text-sm text-foreground-light">{t('people.assign.description')}</p>
              <BindingForm identityId={assigning.identityId} line={line} />
              <div>
                <Button
                  type="button"
                  variant="text"
                  size="small"
                  onClick={() => setAssigning(null)}
                >
                  {t('people.assign.close')}
                </Button>
              </div>
            </section>
          )}
        </div>
        {canManage ? (
          <PageSection>
            <PageSectionMeta>
              <PageSectionSummary>
                <PageSectionTitle>{t('people.invite.title')}</PageSectionTitle>
                <PageSectionDescription>{t('people.invite.description')}</PageSectionDescription>
              </PageSectionSummary>
            </PageSectionMeta>
            <PageSectionContent>
              <InviteForm line={line} onRevealed={setRevealed} />
            </PageSectionContent>
          </PageSection>
        ) : (
          <p className="pt-6 text-sm text-foreground-light">{t('access.manage.missing')}</p>
        )}
        <section aria-label={t('people.list')} className="flex flex-col gap-4 pt-12 pb-12">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              id={searchId}
              label={t('people.filter.text')}
              description={t('people.filter.text.hint')}
            >
              <Input
                id={searchId}
                type="search"
                autoComplete="off"
                spellCheck={false}
                aria-describedby={`${searchId}-description`}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            </Field>
            <Field id={stateId} label={t('people.filter.state')}>
              <NativeSelect
                id={stateId}
                value={state}
                options={STATE_FILTERS.map((value) => ({
                  value,
                  label: stateFilterLabel(value),
                }))}
                onChange={(event) => {
                  if (isStateFilter(event.target.value)) setState(event.target.value)
                }}
              />
            </Field>
          </div>
          <ListView
            readable={readable}
            error={identities.error}
            what={t('people.what')}
            permission="access.read"
            // A filter that leaves nobody is "No match" (below), not an empty list.
            isEmpty={(page) => !filtering && page.items.every((item) => item.kind !== 'human')}
            emptyTitle={t('people.empty.title')}
            emptyDescription={t('people.empty.body')}
            onRetry={() => void identities.refetch()}
            busy={identities.isFetching}
          >
            {(page) => {
              const people = page.items.filter((identity) => identity.kind === 'human')
              const shown = people.filter((identity) => identityMatches(identity, text))
              if (shown.length === 0) {
                return people.length === 0 && !filtering ? null : <NoMatch onReset={reset} />
              }
              return (
                <>
                  {filtering ? (
                    <p className="text-sm text-foreground-light">
                      {t('people.filter.count', { shown: shown.length, total: people.length })}
                    </p>
                  ) : null}
                  <ul id="people-list" className="cards flex flex-col gap-4">
                    {shown.map((identity) => (
                      <PersonCard
                        key={identity.id}
                        identity={identity}
                        bindings={
                          bindingValue === undefined
                            ? undefined
                            : bindingsOf(identity.id, bindingValue.items)
                        }
                        line={line}
                        canManage={canManage}
                        isYou={identity.id === me.identity.id}
                        onRevealed={setRevealed}
                      />
                    ))}
                  </ul>
                </>
              )
            }}
          </ListView>
        </section>
      </PageContainer>
    </>
  )
}
