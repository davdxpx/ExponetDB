import { Badge, Button, Textarea } from '@exponetdb/ui'
import {
  ConfirmDialog,
  type KeyValueItem,
  KeyValueList,
  NotAvailableYetState,
  TierChip,
  TimestampInfo,
  UntrustedName,
  UntrustedText,
} from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import { type FormEvent, type ReactNode, useId, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { useAccessAction } from '../access/actions.ts'
import { Field, NativeSelect } from '../access/fields.tsx'
import { ListView } from '../access/list-view.tsx'
import { actionFailed, type StatusLine, StatusLines, useStatusLine } from '../access/status.tsx'
import {
  grantStateLabel,
  noteProblem,
  noteProblemText,
  REVIEW_NOTE_MAX,
  usesText,
} from './break-glass-model.ts'
import {
  type BreakGlassGrant,
  breakGlassQuery,
  type ReviewFilter,
  SETTINGS_PAGE_LIMIT,
  settingsKeys,
} from './keys.ts'
import { SettingsFrame } from './settings-frame.tsx'

/**
 * `/settings/break-glass` for owners and admins (`policy.manage` at the
 * installation): every break-glass grant (`GET /break-glass-grants`) with its
 * target and tier, who activated it, the reason (untrusted text), the time
 * box, the uses and the review, and the post-incident review of a grant that
 * has ended (`POST /break-glass-grants/{id}/review`: a confirmation, a fresh
 * proof of identity within 300 seconds, once per grant). The note is
 * permanent. Activation is not offered anywhere: it stays refused while the
 * notification channel is open (OD-21), and the page says so.
 */
const FILTERS: readonly ReviewFilter[] = ['all', 'open', 'done']

function filterLabel(filter: ReviewFilter): string {
  switch (filter) {
    case 'all':
      return t('settings.breakGlass.filter.all')
    case 'open':
      return t('settings.breakGlass.filter.open')
    case 'done':
      return t('settings.breakGlass.filter.done')
  }
}

function isFilter(value: string): value is ReviewFilter {
  return (FILTERS as readonly string[]).includes(value)
}

export function BreakGlassPage(): ReactNode {
  const { client } = useApi()
  const line = useStatusLine()
  const filterId = useId()
  const [filter, setFilter] = useState<ReviewFilter>('all')
  const grants = useQuery(breakGlassQuery(client, filter))
  const readable = toReadable(grants, {
    missing: (page) =>
      page.nextCursor === null
        ? undefined
        : [t('settings.breakGlass.more', { count: SETTINGS_PAGE_LIMIT })],
  })
  return (
    <SettingsFrame
      title={t('settings.breakGlass.title')}
      description={t('settings.breakGlass.description')}
    >
      <NotAvailableYetState
        what={t('settings.breakGlass.activation')}
        reason={t('settings.breakGlass.activation.reason')}
        headingLevel={2}
      />
      <div className="max-w-xs">
        <Field id={filterId} label={t('settings.breakGlass.filter')}>
          <NativeSelect
            id={filterId}
            value={filter}
            options={FILTERS.map((value) => ({ value, label: filterLabel(value) }))}
            onChange={(event) => {
              if (isFilter(event.target.value)) setFilter(event.target.value)
            }}
          />
        </Field>
      </div>
      <StatusLines line={line} />
      <section aria-label={t('settings.breakGlass.list')}>
        <ListView
          readable={readable}
          error={grants.error}
          what={t('settings.breakGlass.what')}
          permission="policy.manage"
          isEmpty={(page) => page.items.length === 0}
          emptyTitle={t('settings.breakGlass.empty.title')}
          emptyDescription={t('settings.breakGlass.empty.body')}
          onRetry={() => void grants.refetch()}
          busy={grants.isFetching}
        >
          {(page) => (
            <ul id="break-glass-list" className="cards flex flex-col gap-4">
              {page.items.map((grant) => (
                <GrantCard key={grant.grantId} grant={grant} line={line} />
              ))}
            </ul>
          )}
        </ListView>
      </section>
    </SettingsFrame>
  )
}

function GrantCard({
  grant,
  line,
}: {
  readonly grant: BreakGlassGrant
  readonly line: StatusLine
}): ReactNode {
  const facts: KeyValueItem[] = [
    {
      id: 'grant',
      label: t('settings.breakGlass.grant'),
      value: <code className="font-mono text-xs">{grant.grantId}</code>,
    },
    {
      id: 'activated-by',
      label: t('settings.breakGlass.activatedBy'),
      value: <code className="font-mono text-xs">{grant.activatedBy.identityId}</code>,
    },
    {
      id: 'time-box',
      label: t('settings.breakGlass.timeBox'),
      value: (
        <span className="inline-flex flex-wrap items-baseline gap-x-2">
          <TimestampInfo timestamp={grant.createdAt} />
          <span aria-hidden="true">–</span>
          <span className="sr-only">{t('settings.breakGlass.until')}</span>
          <TimestampInfo timestamp={grant.expiresAt} />
        </span>
      ),
    },
    { id: 'uses', label: t('settings.breakGlass.usesLabel'), value: usesText(grant) },
    {
      id: 'rules',
      label: t('settings.breakGlass.rules'),
      value: <span className="font-mono text-xs">{grant.rules.join(', ')}</span>,
    },
    ...(grant.revokedAt === null
      ? []
      : [
          {
            id: 'revoked',
            label: t('settings.breakGlass.revoked'),
            value: <TimestampInfo timestamp={grant.revokedAt} />,
          },
        ]),
    {
      id: 'reason',
      label: t('settings.breakGlass.reason'),
      value: (
        <UntrustedText text={grant.reason} maxLines={12} label={t('settings.breakGlass.reason')} />
      ),
    },
  ]
  return (
    <li
      className={`card state-${grant.state} flex flex-col gap-4 rounded-lg border border-default bg-surface-100 p-5`}
      data-grant={grant.grantId}
      data-review={grant.review === null ? 'open' : 'done'}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="flex min-w-0 flex-wrap items-center gap-2 text-base font-medium text-foreground">
          <UntrustedName name={grant.target.path} mono label={t('settings.breakGlass.target')} />
          <TierChip tier={grant.target.tier} />
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant={grant.state === 'active' ? 'warning' : 'default'}
            data-state={grant.state}
          >
            {grantStateLabel(grant.state)}
          </Badge>
          <Badge variant={grant.review === null ? 'warning' : 'success'}>
            {grant.review === null
              ? t('settings.breakGlass.review.open')
              : t('settings.breakGlass.review.badgeDone')}
          </Badge>
        </div>
      </div>
      <KeyValueList items={facts} />
      {grant.review === null ? (
        <ReviewForm grant={grant} line={line} />
      ) : (
        <section className="review flex flex-col gap-2">
          <h3 className="text-sm font-medium text-foreground">
            {t('settings.breakGlass.review.title')}
          </h3>
          <p className="flex flex-wrap items-baseline gap-x-2 text-sm text-foreground-light">
            {t('settings.breakGlass.review.by')}{' '}
            <code className="font-mono text-xs">{grant.review.reviewedBy.identityId}</code>
            <TimestampInfo timestamp={grant.review.reviewedAt} />
          </p>
          <UntrustedText
            text={grant.review.note}
            maxLines={20}
            label={t('settings.breakGlass.review.note')}
          />
        </section>
      )}
    </li>
  )
}

function ReviewForm({
  grant,
  line,
}: {
  readonly grant: BreakGlassGrant
  readonly line: StatusLine
}): ReactNode {
  const action = useAccessAction()
  const id = useId()
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [confirming, setConfirming] = useState(false)

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const problem = noteProblem(note)
    if (problem !== undefined) {
      setError(noteProblemText(problem))
      return
    }
    setError(undefined)
    setConfirming(true)
  }

  return (
    <>
      <form className="review-form flex flex-col gap-3" noValidate onSubmit={submit}>
        <h3 className="text-sm font-medium text-foreground">
          {t('settings.breakGlass.review.record')}
        </h3>
        {grant.state === 'active' ? (
          <p className="text-sm text-foreground-light" data-note="active">
            {t('settings.breakGlass.review.stillActive')}
          </p>
        ) : null}
        <Field
          id={`${id}-note`}
          label={t('settings.breakGlass.review.note')}
          description={t('settings.breakGlass.review.warning', { max: REVIEW_NOTE_MAX })}
          error={error}
        >
          <Textarea
            id={`${id}-note`}
            rows={4}
            maxLength={REVIEW_NOTE_MAX}
            value={note}
            aria-invalid={error !== undefined}
            aria-describedby={`${id}-note-description`}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
        <p className="text-xs text-foreground-lighter" aria-live="polite">
          {t('settings.breakGlass.review.count', { count: note.length, max: REVIEW_NOTE_MAX })}
        </p>
        <div>
          <Button type="submit" variant="default" size="small">
            {t('settings.breakGlass.review.submit')}
          </Button>
        </div>
      </form>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('settings.breakGlass.review.confirm.title')}
        description={t('settings.breakGlass.review.confirm.body')}
        actionLabel={t('settings.breakGlass.review.confirm.action')}
        onConfirm={async () => {
          line.clear()
          try {
            await action.run(
              () =>
                action.client.operation('reviewBreakGlassGrant', {
                  params: { grant: grant.grantId },
                  body: { note },
                }),
              settingsKeys.breakGlassAll,
            )
          } catch (failure) {
            throw actionFailed(failure)
          }
          setNote('')
          line.say(t('settings.breakGlass.review.done'))
        }}
      >
        <UntrustedText text={note} maxLines={12} label={t('settings.breakGlass.review.note')} />
      </ConfirmDialog>
    </>
  )
}
