import { Button } from '@exponetdb/ui'
import { NotAvailableYetState, NotPermittedState, NotSupportedState } from '@exponetdb/ui-patterns'
import type { DemoDefinition } from '../types.ts'
import { DemoLinks } from './demo-links.tsx'

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui-patterns/named-states/not-supported',
    title: 'Not supported: what the feature needs and what the target has',
    render: () => (
      <NotSupportedState
        feature="Logical replication slots"
        requires="PostgreSQL 15 or later"
        found="PostgreSQL 14.9"
      />
    ),
  },
  {
    id: 'ui-patterns/named-states/not-supported-hostile',
    title: 'Not supported with a hostile version string: shown as marked text',
    render: () => (
      <NotSupportedState
        feature="Logical replication slots"
        requires="PostgreSQL 15 or later"
        found={'14.9\u{202E}51.41\u{200B}'}
      />
    ),
  },
  {
    id: 'ui-patterns/named-states/not-permitted',
    title: 'Not permitted: the permission and the scope that are missing',
    render: () => (
      <NotPermittedState
        what="the backup inventory"
        permission="backups.read"
        scope="data.read:prod"
      />
    ),
  },
  {
    id: 'ui-patterns/named-states/not-permitted-with-action',
    title: 'Not permitted with the one thing the person can do about it',
    render: () => (
      <NotPermittedState
        what="approvals"
        permission="plans.approve"
        actions={
          <Button type="button" variant="outline">
            Request access
          </Button>
        }
      />
    ),
  },
  {
    id: 'ui-patterns/named-states/not-available-yet',
    title: 'Not available yet: a deliberate state with its reason and a link to the document',
    render: () => (
      <DemoLinks>
        <NotAvailableYetState
          what="The backup inventory"
          reason="Backups arrive with a later wave of ExponetDB. This page shows no data until then."
          docHref="/ui-patterns/named-states"
          docLabel="Read about named states"
        />
      </DemoLinks>
    ),
  },
]
