import { Button } from '@exponetdb/ui'
import {
  ConfirmDialog,
  type PlanClass,
  PlanConfirmDialog,
  type PlanConfirmFacts,
  TypedConfirmDialog,
  WarningConfirmDialog,
} from '@exponetdb/ui-patterns'
import { type ReactNode, useState } from 'react'
import type { DemoDefinition } from '../types.ts'

const HASH = `sha256:${'9b1e'.repeat(16)}`
const OTHER_HASH = `sha256:${'4d7a'.repeat(16)}`

/** A call to the server that takes a moment, so the pending state can be seen. */
function later(milliseconds = 700): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function Result({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="text-sm text-foreground-light">
      {children}
    </p>
  )
}

function WithdrawDemo() {
  const [result, setResult] = useState('Nothing was withdrawn.')
  return (
    <div className="flex flex-col items-start gap-3">
      <ConfirmDialog
        trigger={
          <Button type="button" variant="outline">
            Withdraw plan
          </Button>
        }
        title="Withdraw this plan?"
        description="The plan can no longer be applied. You can create a new plan from the same migration."
        actionLabel="Withdraw plan"
        onConfirm={async () => {
          await later()
          setResult('The plan was withdrawn.')
        }}
      />
      <Result>{result}</Result>
    </div>
  )
}

function AlternativeDemo() {
  const [result, setResult] = useState('No session was touched.')
  return (
    <div className="flex flex-col items-start gap-3">
      <ConfirmDialog
        trigger={
          <Button type="button" variant="outline">
            Stop session 4182
          </Button>
        }
        tier="prod"
        title="Terminate session 4182?"
        description="The session loses its open transaction. Cancelling only its current query keeps the connection."
        actionLabel="Terminate session"
        destructive
        alternative={{
          label: 'Cancel the query',
          onSelect: async () => {
            await later()
            setResult('The query of session 4182 was cancelled.')
          },
        }}
        onConfirm={async () => {
          await later()
          setResult('Session 4182 was terminated.')
        }}
      />
      <Result>{result}</Result>
    </div>
  )
}

function FailureDemo() {
  return (
    <ConfirmDialog
      trigger={
        <Button type="button" variant="outline">
          Withdraw stale plan
        </Button>
      }
      title="Withdraw this plan?"
      description="The server rejects this one, to show how a failure is reported."
      actionLabel="Withdraw plan"
      onConfirm={async () => {
        await later(400)
        throw Object.assign(
          new Error('The target changed since the plan was made. Create a new plan.'),
          { code: 'PLAN_STALE' },
        )
      }}
    />
  )
}

function WarningDemo() {
  const [result, setResult] = useState('No key was revoked.')
  return (
    <div className="flex flex-col items-start gap-3">
      <WarningConfirmDialog
        trigger={
          <Button type="button" variant="outline">
            Revoke API key
          </Button>
        }
        title="Revoke the API key ci-deploy?"
        description="Requests that use this key are refused from now on. A revoked key cannot be restored; create a new one instead."
        actionLabel="Revoke API key"
        destructive
        checklistLegend="Confirm each statement"
        checklist={[
          'The pipelines that use ci-deploy now use another key.',
          'I understand that requests with this key fail at once.',
        ]}
        resetKey="key_ci-deploy"
        onConfirm={async () => {
          await later()
          setResult('The API key ci-deploy was revoked.')
        }}
      />
      <Result>{result}</Result>
    </div>
  )
}

function TypedDemo({ expected, label }: { expected: string; label: string }) {
  const [result, setResult] = useState('No target was removed.')
  return (
    <div className="flex flex-col items-start gap-3">
      <TypedConfirmDialog
        trigger={
          <Button type="button" variant="outline">
            {label}
          </Button>
        }
        tier="prod"
        title="Remove this target from ExponetDB?"
        description="ExponetDB stops managing the target and forgets its registration. The database itself is not touched."
        actionLabel="Remove target"
        destructive
        expectedText={expected}
        expectedTextName="the target path"
        resetKey="remove-target"
        onConfirm={async () => {
          await later()
          setResult('The registration was removed.')
        }}
      />
      <Result>{result}</Result>
    </div>
  )
}

function PlanDemo({
  planClass,
  tier,
  targetPath,
  effect,
  label,
  actionLabel,
}: {
  planClass: PlanClass
  tier: 'prod' | 'nonprod'
  targetPath: string
  effect?: string
  label: string
  actionLabel: string
}) {
  const [result, setResult] = useState('No plan was applied.')
  return (
    <div className="flex flex-col items-start gap-3">
      <PlanConfirmDialog
        trigger={
          <Button type="button" variant="outline">
            {label}
          </Button>
        }
        title={`Apply this plan to ${targetPath}?`}
        description="The plan runs as shown. If the target changed since the plan was made, the apply stops and nothing runs."
        actionLabel={actionLabel}
        destructive={planClass === 'critical'}
        plan={{
          planHash: planClass === 'critical' ? OTHER_HASH : HASH,
          tier,
          planClass,
          targetPath,
          ...(effect === undefined ? {} : { effect }),
        }}
        onConfirm={async (shown: PlanConfirmFacts) => {
          await later()
          setResult(`Applied plan ${shown.planHash.slice(0, 15)}… to ${shown.targetPath}.`)
        }}
      />
      <Result>{result}</Result>
    </div>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui-patterns/confirm-dialog/plain',
    title: 'Plain confirmation for a reversible action',
    visual: false,
    render: () => <WithdrawDemo />,
  },
  {
    id: 'ui-patterns/confirm-dialog/alternative',
    title: 'A less destructive alternative in the same dialog, on a production target',
    visual: false,
    render: () => <AlternativeDemo />,
  },
  {
    id: 'ui-patterns/confirm-dialog/failure',
    title: 'A failure stays in the dialog with its message and stable code',
    visual: false,
    render: () => <FailureDemo />,
  },
  {
    id: 'ui-patterns/warning-confirm-dialog/checklist',
    title: 'Warning confirmation: the action is unavailable until every statement is ticked',
    visual: false,
    render: () => <WarningDemo />,
  },
  {
    id: 'ui-patterns/typed-confirm-dialog/target-path',
    title: 'Typed confirmation: the target path, exactly as shown',
    visual: false,
    render: () => <TypedDemo expected="shop/platform/production" label="Remove target" />,
  },
  {
    id: 'ui-patterns/typed-confirm-dialog/look-alike',
    title: 'Typed confirmation of a name with a look-alike letter: the character is marked',
    visual: false,
    render: () => (
      <TypedDemo
        expected={'shop/pl\u{0430}tform/production'}
        label="Remove target with a look-alike path"
      />
    ),
  },
  {
    id: 'ui-patterns/plan-confirm-dialog/standard',
    title: 'Plan confirmation, standard class on staging: the facts and the action alone',
    visual: false,
    render: () => (
      <PlanDemo
        planClass="standard"
        tier="nonprod"
        targetPath="shop/platform/staging"
        label="Apply to staging"
        actionLabel="Apply to staging"
      />
    ),
  },
  {
    id: 'ui-patterns/plan-confirm-dialog/high',
    title: 'Plan confirmation, high class on production: the target path is typed',
    visual: false,
    render: () => (
      <PlanDemo
        planClass="high"
        tier="prod"
        targetPath="shop/platform/production"
        label="Apply to production"
        actionLabel="Apply to production"
      />
    ),
  },
  {
    id: 'ui-patterns/plan-confirm-dialog/critical',
    title: 'Plan confirmation, critical class: the target path and the effect are typed',
    visual: false,
    render: () => (
      <PlanDemo
        planClass="critical"
        tier="prod"
        targetPath="shop/platform/production"
        effect="replaces placement of shop/platform/production"
        label="Apply critical plan"
        actionLabel="Apply to production"
      />
    ),
  },
]
