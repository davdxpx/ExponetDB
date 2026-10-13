import {
  Admonition,
  LoadingState,
  PageContainer,
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
} from '@exponetdb/ui-patterns'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { useMe } from '../../lib/session/guard.tsx'
import { RecoveryCodesPanel } from '../enrollment/recovery-codes.tsx'
import { FeedbackLines, useFeedback } from '../sign-in/feedback.tsx'
import { isRecoverySession } from './account-model.ts'
import { FactorsSection } from './factors-section.tsx'
import { GrantsSection } from './grants-section.tsx'
import { IdentitySection } from './identity-section.tsx'
import { accountKeys, factorsQuery, grantsQuery, sessionsQuery } from './keys.ts'
import { PasskeysSection } from './passkeys-section.tsx'
import { SessionsSection } from './sessions-section.tsx'
import { useAccountWriter } from './writer.ts'

/**
 * The signed-in person's own account (`/account`, inside the shell): who
 * they are and their roles, their passkeys, password, authenticator app and
 * recovery codes, their sessions and the applications connected to them.
 * Every change goes through re-authentication when the server asks for it.
 * A recovery session (signed in with a recovery code) may only replace its
 * factors: the page says so (`#recovery-banner`), reads no connected
 * applications and offers no session changes; the banner goes once a new
 * passkey and a new authenticator app ended the recovery. New recovery codes
 * replace the page's content until the person confirms they stored them,
 * and are then dropped. Sign-out is in the shell's account menu.
 */
/**
 * The person's own lists change only through this page or another session of
 * theirs; a read counts as stale after ten minutes (the page reads again on
 * focus and after every change).
 */
const ACCOUNT_STALE_MS = 10 * 60_000

export function AccountPage(): ReactNode {
  const me = useMe()
  const { client } = useApi()
  const queryClient = useQueryClient()
  const feedback = useFeedback()
  const writer = useAccountWriter(feedback)
  const recovery = isRecoverySession(me)
  const factors = useQuery(factorsQuery(client))
  const sessions = useQuery(sessionsQuery(client))
  const grants = useQuery(grantsQuery(client, !recovery))
  const [codes, setCodes] = useState<readonly string[] | undefined>(undefined)

  // The page appears once its own reads have answered, all at once (as the Wave 3A page did).
  const settled = !factors.isPending && !sessions.isPending
  const readable = { staleAfterMs: ACCOUNT_STALE_MS }

  return (
    <>
      <PageHeader size="small">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{t('account.title')}</PageHeaderTitle>
            <PageHeaderDescription>{t('account.description')}</PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="small" className="flex flex-col gap-8 py-6">
        <FeedbackLines feedback={feedback} />
        {codes !== undefined ? (
          <RecoveryCodesPanel
            codes={codes}
            onContinue={() => {
              // Shown once: the codes leave the page's state now.
              setCodes(undefined)
              feedback.say(t('account.codes.closed'))
              void queryClient.invalidateQueries({ queryKey: accountKeys.factors })
            }}
          />
        ) : !settled ? (
          <LoadingState what={t('account.reading')} lines={6} />
        ) : (
          <>
            {recovery ? (
              <Admonition
                id="recovery-banner"
                type="warning"
                title={t('account.recovery.title')}
                description={t('account.recovery.body')}
              />
            ) : null}
            <IdentitySection me={me} />
            <PasskeysSection
              factors={toReadable(factors, readable)}
              writer={writer}
              onRetry={() => void factors.refetch()}
            />
            <FactorsSection
              factors={toReadable(factors, readable)}
              writer={writer}
              feedback={feedback}
              onCodes={setCodes}
            />
            <SessionsSection
              sessions={toReadable(sessions, readable)}
              writer={writer}
              recovery={recovery}
              onRetry={() => void sessions.refetch()}
            />
            {recovery ? null : (
              <GrantsSection
                grants={toReadable(grants, readable)}
                writer={writer}
                onRetry={() => void grants.refetch()}
              />
            )}
          </>
        )}
      </PageContainer>
    </>
  )
}
