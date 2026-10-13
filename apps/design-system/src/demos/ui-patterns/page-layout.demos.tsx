import { Button } from '@exponetdb/ui'
import {
  KeyValueList,
  PageBreadcrumbs,
  PageBreadcrumbsActions,
  PageContainer,
  PageHeader,
  PageHeaderAside,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
  PageNav,
  PageSection,
  PageSectionAside,
  PageSectionContent,
  PageSectionDescription,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
  TierChip,
} from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import type { DemoDefinition } from '../types.ts'
import { DemoLinks } from './demo-links.tsx'

/**
 * A target page the way the Web App composes it: the breadcrumb row, the
 * section navigation, then the container with the header and the sections.
 * The title carries `aria-level` only so that the design-system page keeps its
 * own `h1`; a real page has one `PageHeaderTitle` and it is the `h1`.
 */
function TargetPage({ environment, tier }: { environment: string; tier: 'prod' | 'nonprod' }) {
  const path = `shop/platform/${environment}`
  return (
    <DemoLinks>
      <div className="overflow-hidden rounded-md border border-default bg-background">
        <PageBreadcrumbs
          items={[
            { label: 'Databases', href: '/targets' },
            { label: 'shop', href: '/targets' },
            { label: 'platform', href: '/targets' },
            { label: environment },
          ]}
          actions={
            <PageBreadcrumbsActions>
              <Button type="button" size="tiny">
                Create plan
              </Button>
            </PageBreadcrumbsActions>
          }
        />
        <PageNav
          label="Target sections"
          items={[
            { label: 'Overview', href: `/t/${path}`, active: false },
            { label: 'Configuration', href: `/t/${path}/configuration`, active: true },
            { label: 'Migrations', href: `/t/${path}/migrations`, active: false },
            { label: 'Backups', href: `/t/${path}/backups`, active: false },
          ]}
        />
        <PageContainer size="default">
          <PageHeader size="default">
            <PageHeaderMeta>
              <PageHeaderSummary>
                <PageHeaderTitle
                  aria-level={2}
                  productionCue={
                    tier === 'prod' ? <TierChip tier={tier} name={environment} /> : undefined
                  }
                >
                  Configuration
                </PageHeaderTitle>
                <PageHeaderDescription>
                  Settings of {path} that apply to its plans and data reads.
                </PageHeaderDescription>
              </PageHeaderSummary>
              <PageHeaderAside>
                <Button type="button" variant="outline">
                  Edit settings
                </Button>
              </PageHeaderAside>
            </PageHeaderMeta>
          </PageHeader>
          <PageSection>
            <PageSectionMeta>
              <PageSectionSummary>
                <PageSectionTitle>Plans</PageSectionTitle>
                <PageSectionDescription>
                  How long a plan stays valid and who must approve it.
                </PageSectionDescription>
              </PageSectionSummary>
              <PageSectionAside>
                <Button type="button" variant="outline">
                  View policy
                </Button>
              </PageSectionAside>
            </PageSectionMeta>
            <PageSectionContent>
              <KeyValueList
                items={[
                  { id: 'expiry', label: 'Plan expiry', value: '15 minutes' },
                  {
                    id: 'approvals',
                    label: 'Approvals',
                    value: tier === 'prod' ? '1 person other than the creator' : 'None required',
                  },
                ]}
              />
            </PageSectionContent>
          </PageSection>
        </PageContainer>
      </div>
    </DemoLinks>
  )
}

function Frame({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-4">{children}</div>
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui-patterns/page-layout/production-target',
    title: 'A page of a production target: the production chip sits beside the title',
    render: () => (
      <Frame>
        <TargetPage environment="production" tier="prod" />
      </Frame>
    ),
  },
  {
    id: 'ui-patterns/page-layout/nonproduction-target',
    title: 'A page of a staging target: the same layout and no production cue',
    render: () => (
      <Frame>
        <TargetPage environment="staging" tier="nonprod" />
      </Frame>
    ),
  },
]
