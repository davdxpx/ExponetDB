import { ObservedTime, UntrustedName, useLinkComponent } from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { nounPhrase } from '../target/phrases.ts'
import { driftFindingsQuery } from '../target-ops/keys.ts'
import { useTargetHref, useTargetPath } from '../target-ops/links.ts'
import { SeverityBadge } from '../target-ops/paged.tsx'
import { ReadSection } from '../target-ops/read-section.tsx'
import { Section } from '../target-ops/section.tsx'

/**
 * The open drift findings of the target in short (`GET /targets/{t}/findings`,
 * `kind=drift`), newest first, with the link to the Drift page where they are
 * compared and accepted. A longer list says so.
 */
export function DriftSummary(): ReactNode {
  const { client } = useApi()
  const path = useTargetPath()
  const href = useTargetHref()
  const Link = useLinkComponent()
  const query = useQuery(driftFindingsQuery(client, path))
  return (
    <Section
      id="drift"
      title={t('migrations.drift.title')}
      description={t('migrations.drift.description')}
    >
      <ReadSection
        query={query}
        what={nounPhrase('migrations.drift.what')}
        permission="diagnostics.read"
        missing={(page) => (page.nextCursor === null ? undefined : [t('migrations.drift.more')])}
        empty={{
          isEmpty: (page) => page.items.length === 0,
          content: (
            <p className="m-0 text-sm text-foreground-light" data-empty="drift">
              {t('migrations.drift.empty')}
            </p>
          ),
        }}
        ready={(page) => (
          <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
            {page.items.map((finding) => (
              <li key={finding.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <SeverityBadge severity={finding.severity} />
                <UntrustedName
                  name={finding.object ?? finding.code}
                  mono
                  maxCodePoints={60}
                  label={t('migrations.drift.object')}
                />
                <span className="text-xs text-foreground-light">
                  <ObservedTime observedAt={finding.lastSeenAt} />
                </span>
              </li>
            ))}
          </ul>
        )}
      />
      <p className="m-0 text-sm">
        <Link href={href('/drift')} className="text-primary underline focus-ring">
          {t('migrations.drift.open')}
        </Link>
      </p>
    </Section>
  )
}
