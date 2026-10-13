import { Database } from '@exponetdb/icons'
import { Button } from '@exponetdb/ui'
import {
  Admonition,
  EmptyState,
  ErrorDisplay,
  FailedReadState,
  InfoTooltip,
} from '@exponetdb/ui-patterns'
import type { DemoDefinition } from '../types.ts'

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui-patterns/admonition/types',
    title: 'Admonition: one type per intent, each with its own icon shape and a title',
    render: () => (
      <div className="flex flex-col gap-3">
        <Admonition
          type="default"
          title="Plans expire"
          description="A plan is valid for 15 minutes. Create a new plan if it expires before you apply it."
        />
        <Admonition
          type="info"
          title="Reads come from the Control Store"
          description="This list shows the last mirror of each target ledger, not a live read."
        />
        <Admonition
          type="success"
          title="Verification passed"
          description="The change was applied and its verify.sql returned the expected rows."
        />
        <Admonition
          type="warning"
          title="Staging has not verified this migration"
          description="Production requires the same checksum applied and verified on staging."
        />
        <Admonition
          type="destructive"
          title="This plan drops a table"
          description="Only a backup can bring the data back. Check the backup state before you apply it."
        />
      </div>
    ),
  },
  {
    id: 'ui-patterns/admonition/with-actions',
    title: 'Admonition with actions, in the responsive layout',
    render: () => (
      <Admonition
        type="warning"
        layout="responsive"
        title="2 findings need a decision"
        description="The schema of shop/platform/staging differs from its last fingerprint."
        actions={
          <>
            <Button type="button" variant="outline" size="tiny">
              Review findings
            </Button>
            <Button type="button" variant="text" size="tiny">
              Dismiss
            </Button>
          </>
        }
      />
    ),
  },
  {
    id: 'ui-patterns/empty-state/after-successful-read',
    title: 'Empty state: a list that was read and holds nothing, with the action that fills it',
    render: () => (
      <EmptyState
        icon={Database}
        title="No targets in this project"
        description="The read succeeded and found no targets. Register the first target to see it here."
      >
        <Button type="button" variant="primary">
          Register target
        </Button>
      </EmptyState>
    ),
  },
  {
    id: 'ui-patterns/error-display/frame',
    title: 'Error display: what failed, the reason, notes, the stable code and the next action',
    render: () => (
      <ErrorDisplay
        title="Could not create the plan"
        message="The migration depends on 01JABCDEFGHJKMNPQRSTVWXYZ1, which is not in this project."
        code="MIGRATION_DEPENDENCY_MISSING"
        actions={
          <Button type="button" size="tiny" variant="outline">
            Open the migration list
          </Button>
        }
      >
        <p className="px-4 py-3 text-sm text-foreground-light">
          Add the missing bundle or remove the dependency from migration.yaml, then create the plan
          again.
        </p>
      </ErrorDisplay>
    ),
  },
  {
    id: 'ui-patterns/error-display/failed-read',
    title: 'Failed read: the only thing a read that failed renders, with a retry',
    render: () => (
      <FailedReadState
        what="backup inventory"
        error={{
          code: 'TARGET_UNREACHABLE',
          message: 'The cluster did not answer within 5 seconds.',
        }}
        onRetry={() => undefined}
      />
    ),
  },
  {
    id: 'ui-patterns/error-display/hostile-reason',
    title: 'A reason that carries markup is shown as text, not as markup',
    render: () => (
      <ErrorDisplay
        title="Could not read the comment"
        message={'<img src=x onerror=exfiltrate()> <script>run()</script>'}
        code="UNKNOWN"
      />
    ),
  },
  {
    id: 'ui-patterns/info-tooltip/default',
    title: 'Info tooltip: a button named "More information" that explains in a tooltip',
    render: () => (
      <p className="flex items-center gap-2 text-sm">
        Plan class
        <InfoTooltip label="What a plan class is" side="top">
          The class says how much a plan can change. High and critical plans need the target path
          typed before they can be applied.
        </InfoTooltip>
      </p>
    ),
  },
]
