import { FolderKanban, RefreshCw } from '@exponetdb/icons'
import { Button } from '@exponetdb/ui'
import {
  ObservedTime,
  PageContainer,
  PageHeader,
  PageHeaderAside,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
  ReadableView,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { targetListKeys } from '../targets/keys.ts'
import { AttentionSection } from './attention.tsx'
import { ControlPlane } from './control-plane.tsx'
import { FindingsTriage } from './findings-triage.tsx'
import { HealthStrip } from './health-strip.tsx'
import { fleetQuery } from './keys.ts'
import { KpiCards } from './kpi-cards.tsx'
import { PROJECTS_PATH } from './links.ts'
import { type FleetModel, fleetModel } from './model.ts'
import { ProtectionSlot } from './protection-slot.tsx'
import { WorkQueue } from './work-queue.tsx'

/**
 * The fleet overview (`/`), a command centre rather than a wall of equal boxes: first the key
 * numbers as cards that are links to the lists behind them, then what needs a person, worst
 * first (the findings by severity with the newest critical ones, the databases with the worst
 * health, the operations that stopped), then how the fleet and ExponetDB itself are doing.
 * One request counts the fleet (`GET /fleet`), so the counts do not cost more with the number of
 * targets; every part reads and fails on its own; a count that is a floor says "at least"; a part
 * the server could not count says why and is never zero; a failed read is an error, not a card
 * of zeros (C-28). Where a count came from and when is said once, under the heading; a card
 * repeats it only when it is out of date.
 */
export function FleetPage(): ReactNode {
  const { client } = useApi()
  const Link = useLinkComponent()
  const queryClient = useQueryClient()
  const fleet = useQuery(fleetQuery(client))
  const refreshing = useIsFetching({ queryKey: ['fleet'] }) > 0
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['fleet'] })
    void queryClient.invalidateQueries({ queryKey: targetListKeys.list() })
  }
  return (
    <>
      <PageHeader size="large">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{t('fleet.title')}</PageHeaderTitle>
            <PageHeaderDescription>{t('fleet.description')}</PageHeaderDescription>
          </PageHeaderSummary>
          <PageHeaderAside>
            <Button
              type="button"
              variant="default"
              size="small"
              loading={refreshing}
              icon={<RefreshCw aria-hidden="true" strokeWidth={1.5} />}
              onClick={refresh}
            >
              {t('fleet.refresh')}
            </Button>
            <Button
              asChild
              variant="default"
              size="small"
              icon={<FolderKanban aria-hidden="true" strokeWidth={1.5} />}
            >
              <Link href={PROJECTS_PATH}>{t('fleet.projects')}</Link>
            </Button>
          </PageHeaderAside>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="large" className="flex flex-col gap-10 py-6">
        <ReadableView
          readable={toReadable(fleet)}
          what={t('fleet.read.what')}
          onRetry={() => void fleet.refetch()}
          onRefresh={() => void fleet.refetch()}
          busy={fleet.isFetching}
          headingLevel={2}
          ready={(value) => <FleetSummary model={fleetModel(value)} />}
        />
        <div className="grid grid-cols-1 gap-x-8 gap-y-10 xl:grid-cols-5">
          <FindingsTriage className="xl:col-span-3" />
          <AttentionSection className="xl:col-span-2" />
        </div>
        <div className="grid grid-cols-1 gap-x-8 gap-y-10 xl:grid-cols-5">
          <WorkQueue className="xl:col-span-3" />
          <div className="flex flex-col gap-10 xl:col-span-2">
            <ProtectionSlot />
            <ControlPlane />
          </div>
        </div>
      </PageContainer>
    </>
  )
}

function FleetSummary({ model }: { readonly model: FleetModel }): ReactNode {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <p className="m-0 text-xs text-foreground-lighter" data-fleet-as-of>
          {t('fleet.counted', { source: model.targets.source })}{' '}
          <ObservedTime observedAt={model.asOf} />
        </p>
        <KpiCards model={model} />
      </div>
      <HealthStrip targets={model.targets} />
    </div>
  )
}
