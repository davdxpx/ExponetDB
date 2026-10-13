import { Button } from '@exponetdb/ui'
import {
  ConfirmDialog,
  PlanConfirmDialog,
  type PlanConfirmFacts,
  TypedConfirmDialog,
  WarningConfirmDialog,
} from '@exponetdb/ui-patterns'
import { type ReactNode, useState } from 'react'
import type { DemoDefinition } from '../types.ts'
import { Outcome, wait } from './support.tsx'

/** A made-up plan hash: `sha256:` and 64 lowercase hex digits. */
const PLAN_HASH = `sha256:${'9f2c1ab04e7d5c3b'.repeat(4)}`

function shortHash(hash: string): string {
  return `${hash.slice(0, 15)}…`
}

function PlainConfirm(): ReactNode {
  const [message, setMessage] = useState('')
  return (
    <div>
      <ConfirmDialog
        trigger={<Button variant="default">Withdraw plan</Button>}
        title="Withdraw this plan?"
        description="The plan can no longer be applied. Nothing on the target has changed, and you can create a new plan at any time."
        actionLabel="Withdraw plan"
        onConfirm={async () => {
          await wait(300)
          setMessage('Plan withdrawn.')
        }}
      />
      <Outcome>{message}</Outcome>
    </div>
  )
}

function WarningConfirm(): ReactNode {
  const [message, setMessage] = useState('')
  return (
    <div>
      <WarningConfirmDialog
        trigger={<Button variant="default">Revoke API key</Button>}
        title="Revoke this API key?"
        description="Every service that uses the key loses access at once. A revoked key cannot be restored."
        checklist={[
          'I know which services use this key.',
          'I created a replacement key, or I accept that their access stops.',
        ]}
        resetKey="key_01K9D4"
        actionLabel="Revoke API key"
        destructive
        onConfirm={async () => {
          await wait(300)
          setMessage('API key revoked.')
        }}
      />
      <Outcome>{message}</Outcome>
    </div>
  )
}

function TypedConfirm(): ReactNode {
  const [message, setMessage] = useState('')
  return (
    <div>
      <TypedConfirmDialog
        trigger={<Button variant="default">Decommission target</Button>}
        title="Decommission this target?"
        description="ExponetDB stops managing the target. The database itself is not deleted."
        expectedText="shop/platform/staging"
        expectedTextName="the target path"
        tier="nonprod"
        actionLabel="Decommission target"
        destructive
        onConfirm={async () => {
          await wait(300)
          setMessage('Decommission requested for shop/platform/staging.')
        }}
      />
      <Outcome>{message}</Outcome>
    </div>
  )
}

function PlanConfirm({
  plan,
  trigger,
  title,
  description,
  actionLabel,
}: {
  readonly plan: PlanConfirmFacts
  readonly trigger: string
  readonly title: string
  readonly description: string
  readonly actionLabel: string
}): ReactNode {
  const [message, setMessage] = useState('')
  return (
    <div>
      <PlanConfirmDialog
        trigger={<Button variant="primary">{trigger}</Button>}
        title={title}
        description={description}
        actionLabel={actionLabel}
        plan={plan}
        onConfirm={async (shown) => {
          await wait(300)
          setMessage(
            `Apply accepted for plan ${shortHash(shown.planHash)}. The operation is queued; its verification comes after it finishes.`,
          )
        }}
      />
      <Outcome>{message}</Outcome>
    </div>
  )
}

/**
 * A table name that is not what it looks like: a Cyrillic "e" in place of the Latin one, and a
 * zero-width space at the end. The dialog shows both by code point.
 */
const HOSTILE_TABLE = 'ord\u{0435}rs\u{200B}'

function HostileTypedConfirm(): ReactNode {
  const [message, setMessage] = useState('')
  return (
    <div>
      <TypedConfirmDialog
        trigger={<Button variant="default">Create plan to drop table</Button>}
        title="Drop this table?"
        description="Creates a plan that drops the table. Nothing is dropped until the plan is applied."
        expectedText={HOSTILE_TABLE}
        expectedTextName="the table name"
        tier="nonprod"
        actionLabel="Create plan"
        destructive
        onConfirm={async () => {
          await wait(300)
          setMessage('Plan created.')
        }}
      />
      <Outcome>{message}</Outcome>
    </div>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'guidance/confirmation-ladder/plain',
    title: 'Plain: a reversible action',
    visual: false,
    render: () => <PlainConfirm />,
  },
  {
    id: 'guidance/confirmation-ladder/warning',
    title: 'Warning: tick each statement first',
    visual: false,
    render: () => <WarningConfirm />,
  },
  {
    id: 'guidance/confirmation-ladder/typed',
    title: 'Typed: type the target path before the action is available',
    visual: false,
    render: () => <TypedConfirm />,
  },
  {
    id: 'guidance/confirmation-ladder/plan-standard',
    title: 'Plan, standard class on a non-production target: the action alone',
    visual: false,
    render: () => (
      <PlanConfirm
        trigger="Apply to staging"
        title="Apply to staging?"
        description="Applies 2 migrations to shop/platform/staging."
        actionLabel="Apply to staging"
        plan={{
          planHash: PLAN_HASH,
          tier: 'nonprod',
          planClass: 'standard',
          targetPath: 'shop/platform/staging',
        }}
      />
    ),
  },
  {
    id: 'guidance/confirmation-ladder/plan-high',
    title: 'Plan, high class on production: the target path is typed',
    visual: false,
    render: () => (
      <PlanConfirm
        trigger="Apply to production"
        title="Apply to production?"
        description="Applies 2 migrations to shop/platform/production. Both were applied and verified on staging."
        actionLabel="Apply to production"
        plan={{
          planHash: PLAN_HASH,
          tier: 'prod',
          planClass: 'high',
          targetPath: 'shop/platform/production',
        }}
      />
    ),
  },
  {
    id: 'guidance/confirmation-ladder/plan-critical',
    title: 'Plan, critical class on production: the target path and the effect are typed',
    visual: false,
    render: () => (
      <PlanConfirm
        trigger="Replace placement"
        title="Replace the placement of shop/platform/production?"
        description="Moves the target to another cluster. Applications must reconnect."
        actionLabel="Replace placement"
        plan={{
          planHash: PLAN_HASH,
          tier: 'prod',
          planClass: 'critical',
          targetPath: 'shop/platform/production',
          effect: 'replaces placement of shop/platform/production',
        }}
      />
    ),
  },
  {
    id: 'guidance/confirmation-ladder/hostile-name',
    title: 'Typed, with a name that hides characters: they are shown by code point',
    visual: false,
    render: () => <HostileTypedConfirm />,
  },
]
