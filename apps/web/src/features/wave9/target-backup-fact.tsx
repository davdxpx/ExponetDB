import { useLinkComponent } from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { isClusterId } from '../target-ops/ids.ts'
import { protectionQuery } from './keys.ts'
import { ProtectionBadge } from './parts.tsx'

/**
 * The "Backups" fact of a target's overview (PRE-WAVE-11-REVIEW U9): the
 * protection state of the cluster the target is placed on, linked to the
 * target's backups page. It reads one catalog page of one backup and says
 * what happened in a few words: reading, could not read (with the code; never
 * a state), no placement, or the state as a word (only `protected` is good).
 */
export function TargetBackupFact({
  clusterId,
  href,
}: {
  readonly clusterId: string | undefined
  readonly href: string
}): ReactNode {
  const { client } = useApi()
  const Link = useLinkComponent()
  const query = useQuery(protectionQuery(client, clusterId ?? ''))
  if (clusterId === undefined || !isClusterId(clusterId)) {
    return <span className="text-foreground-light">{t('wave9.fact.noPlacement')}</span>
  }
  const readable = toReadable(query)
  switch (readable.state) {
    case 'loading':
      return <span className="text-foreground-light">{t('wave9.fact.reading')}</span>
    case 'failed':
      return (
        <span className="text-foreground-light" data-fact-state="failed">
          {t('wave9.fact.failed', { code: readable.error.code })}
        </span>
      )
    default:
      return (
        <Link href={href} className="rounded-sm focus-ring" data-fact-state={readable.state}>
          <ProtectionBadge state={readable.value.protection.state} />
          {readable.state === 'stale' ? (
            <span className="ml-1 text-xs text-foreground-light">{t('wave9.fact.stale')}</span>
          ) : null}
        </Link>
      )
  }
}
