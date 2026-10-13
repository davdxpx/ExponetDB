import { Button, Label } from '@exponetdb/ui'
import {
  NotPermittedState,
  ReadableView,
  UntrustedName,
  useOpenShortcutHelp,
} from '@exponetdb/ui-patterns'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { type ReactNode, useId } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { setLetterShortcuts, useLetterShortcuts } from '../../lib/preferences/shortcuts.ts'
import {
  parseSidebarMode,
  type SidebarMode,
  setSidebarMode,
  useSidebarMode,
} from '../../lib/preferences/sidebar.ts'
import {
  parseThemePreference,
  setThemePreference,
  type ThemePreference,
  useThemePreference,
} from '../../lib/preferences/theme.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { useMe } from '../../lib/session/guard.tsx'
import { FeedbackLines, useFeedback } from '../sign-in/feedback.tsx'
import { TimeText } from '../sign-in/time-text.tsx'
import { GrantsSection } from './grants-section.tsx'
import { IdentitySection } from './identity-section.tsx'
import { activityQuery, grantsQuery } from './keys.ts'
import type { ProfileMe } from './profile-model.ts'
import { ProfileSection } from './profile-section.tsx'
import { SectionHeading } from './section.tsx'
import { ACCOUNT_STALE_MS } from './security-page.tsx'
import { useAccountWriter } from './writer.ts'

/** The tab `/account`: who the person is, their name and their picture. */
export function ProfilePage(): ReactNode {
  const me = useMe() as ProfileMe
  const feedback = useFeedback()
  const writer = useAccountWriter(feedback)
  return (
    <div className="flex flex-col gap-8">
      <FeedbackLines feedback={feedback} />
      <IdentitySection me={me} />
      <ProfileSection me={me} writer={writer} feedback={feedback} />
    </div>
  )
}

/** The tab `/account/applications`: the applications connected to the person. */
export function ApplicationsPage(): ReactNode {
  const { client } = useApi()
  const feedback = useFeedback()
  const writer = useAccountWriter(feedback)
  const grants = useQuery(grantsQuery(client, true))
  return (
    <div className="flex flex-col gap-8">
      <FeedbackLines feedback={feedback} />
      <GrantsSection
        grants={toReadable(grants, { staleAfterMs: ACCOUNT_STALE_MS })}
        writer={writer}
        onRetry={() => void grants.refetch()}
      />
    </div>
  )
}

const THEMES: readonly { readonly value: ThemePreference; readonly label: () => string }[] = [
  { value: 'system', label: () => t('shell.theme.system') },
  { value: 'light', label: () => t('shell.theme.light') },
  { value: 'dark', label: () => t('shell.theme.dark') },
]

const SIDEBAR_MODES: readonly { readonly value: SidebarMode; readonly label: () => string }[] = [
  { value: 'hover', label: () => t('shell.sidebar.hover') },
  { value: 'open', label: () => t('shell.sidebar.open') },
  { value: 'collapsed', label: () => t('shell.sidebar.collapsed') },
]

function Choice({
  name,
  value,
  checked,
  label,
  onSelect,
}: {
  readonly name: string
  readonly value: string
  readonly checked: boolean
  readonly label: string
  readonly onSelect: (value: string) => void
}): ReactNode {
  const id = useId()
  return (
    <div className="flex items-center gap-2">
      <input
        id={id}
        type="radio"
        name={name}
        value={value}
        checked={checked}
        className="size-4 accent-[var(--brand-default)]"
        onChange={() => onSelect(value)}
      />
      <Label htmlFor={id} className="text-sm font-normal text-foreground">
        {label}
      </Label>
    </div>
  )
}

/** The tab `/account/preferences`: theme, sidebar, shortcuts. Kept in this browser only. */
export function PreferencesPage(): ReactNode {
  const theme = useThemePreference()
  const sidebar = useSidebarMode()
  const letters = useLetterShortcuts()
  const openHelp = useOpenShortcutHelp()
  const lettersId = useId()
  const lettersHintId = useId()
  return (
    <div className="flex flex-col gap-8">
      <p className="text-sm text-foreground-light">{t('preferences.note')}</p>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-lg font-medium text-foreground">
          {t('preferences.theme')}
        </legend>
        {THEMES.map((option) => (
          <Choice
            key={option.value}
            name="theme"
            value={option.value}
            checked={theme === option.value}
            label={option.label()}
            onSelect={(value) =>
              setThemePreference(parseThemePreference(value), document.documentElement)
            }
          />
        ))}
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-lg font-medium text-foreground">
          {t('preferences.sidebar')}
        </legend>
        {SIDEBAR_MODES.map((option) => (
          <Choice
            key={option.value}
            name="sidebar"
            value={option.value}
            checked={sidebar === option.value}
            label={option.label()}
            onSelect={(value) => setSidebarMode(parseSidebarMode(value))}
          />
        ))}
      </fieldset>
      <section className="flex flex-col gap-2" aria-label={t('preferences.shortcuts')}>
        <h2 className="text-lg font-medium text-foreground">{t('preferences.shortcuts')}</h2>
        <div className="flex items-center gap-2">
          <input
            id={lettersId}
            type="checkbox"
            checked={letters}
            aria-describedby={lettersHintId}
            className="size-4 accent-[var(--brand-default)]"
            onChange={(event) => setLetterShortcuts(event.target.checked)}
          />
          <Label htmlFor={lettersId} className="text-sm font-normal text-foreground">
            {t('preferences.shortcuts.letters')}
          </Label>
        </div>
        <p id={lettersHintId} className="text-xs text-foreground-lighter">
          {t('preferences.shortcuts.letters.hint')}
        </p>
        <div>
          <Button type="button" variant="default" size="small" onClick={() => openHelp?.()}>
            {t('preferences.shortcuts.show')}
          </Button>
        </div>
      </section>
    </div>
  )
}

const RESULT = {
  succeeded: 'account.activity.result.succeeded',
  failed: 'account.activity.result.failed',
  denied: 'account.activity.result.denied',
} as const

const CLIENT = {
  web: 'account.activity.client.web',
  rest: 'account.activity.client.rest',
  mcp: 'account.activity.client.mcp',
  cli: 'account.activity.client.cli',
  ci: 'account.activity.client.ci',
  system: 'account.activity.client.system',
} as const

/**
 * The tab `/account/activity`: the audit events with the person as the
 * actor, newest first (`GET /audit-events?actor=self`). Reading audit needs
 * `audit.read`: anyone else sees the named not-permitted state, never an
 * empty list.
 */
export function ActivityPage(): ReactNode {
  const { client } = useApi()
  const headingId = useId()
  const query = useInfiniteQuery(activityQuery(client))
  const refused =
    query.data === undefined &&
    query.isError &&
    classifyFailure(query.error).kind === 'not_permitted'
  const readable = toReadable(query, { staleAfterMs: ACCOUNT_STALE_MS })
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <SectionHeading id={headingId}>{t('account.activity.heading')}</SectionHeading>
      <p className="text-sm text-foreground-light">{t('account.activity.description')}</p>
      {refused ? (
        <NotPermittedState
          what={t('account.activity.what').toLowerCase()}
          permission="audit.read"
          headingLevel={3}
        />
      ) : (
        <ReadableView
          readable={readable}
          what={t('account.activity.what').toLowerCase()}
          headingLevel={3}
          onRetry={() => void query.refetch()}
          empty={{
            isEmpty: (value) => value.items.length === 0,
            content: (
              <p id="no-activity" className="text-sm text-foreground-light">
                {t('account.activity.none')}
              </p>
            ),
          }}
          ready={(value) => (
            <div className="flex flex-col gap-3">
              <ul
                id="activity-list"
                className="flex flex-col divide-y divide-border rounded-lg border border-default"
              >
                {value.items.map((event) => (
                  <li
                    key={event.id}
                    className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm"
                  >
                    <UntrustedName name={event.action} mono label={t('account.activity.action')} />
                    <span className="flex flex-wrap gap-x-3 text-xs text-foreground-lighter">
                      <span>{t(RESULT[event.result.status])}</span>
                      {event.client === null ? null : <span>{t(CLIENT[event.client.kind])}</span>}
                      <TimeText value={event.occurredAt} />
                    </span>
                  </li>
                ))}
              </ul>
              {value.hasMore ? (
                <div>
                  <Button
                    type="button"
                    variant="default"
                    size="small"
                    loading={query.isFetchingNextPage}
                    onClick={() => void query.fetchNextPage()}
                  >
                    {t('account.activity.more')}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        />
      )}
    </section>
  )
}
