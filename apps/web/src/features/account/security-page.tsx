import { Admonition, LoadingState } from '@exponetdb/ui-patterns'
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
import { accountKeys, factorsQuery, sessionsQuery } from './keys.ts'
import { PasskeysSection } from './passkeys-section.tsx'
import { SessionsSection } from './sessions-section.tsx'
import { useAccountWriter } from './writer.ts'

/**
 * The security tab of the account area (`/account/security`): the person's
 * passkeys, password, authenticator app and recovery codes, and their
 * sessions. Every change goes through re-authentication when the server asks
 * for it. A recovery session (signed in with a recovery code) may only
 * replace its factors: the area shows this tab for every tab, with the
 * banner (`#recovery-banner`) and no session changes; the banner goes once a
 * new passkey and a new authenticator app ended the recovery. New recovery
 * codes replace the tab's content until the person confirms they stored
 * them, and are then dropped. Sign-out is in the shell's account menu.
 */

/**
 * The person's own lists change only through this area or another session of
 * theirs; a read counts as stale after ten minutes (the page reads again on
 * focus and after every change).
 */
export const ACCOUNT_STALE_MS = 10 * 60_000

export function SecurityPage(): ReactNode {
  const me = useMe()
  const { client } = useApi()
  const queryClient = useQueryClient()
  const feedback = useFeedback()
  const writer = useAccountWriter(feedback)
  const recovery = isRecoverySession(me)
  const factors = useQuery(factorsQuery(client))
  const sessions = useQuery(sessionsQuery(client))
  const [codes, setCodes] = useState<readonly string[] | undefined>(undefined)

  // The tab appears once its own reads have answered, all at once (as the Wave 3A page did).
  const settled = !factors.isPending && !sessions.isPending
  const readable = { staleAfterMs: ACCOUNT_STALE_MS }

  return (
    <div className="flex flex-col gap-8">
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
        </>
      )}
    </div>
  )
}
