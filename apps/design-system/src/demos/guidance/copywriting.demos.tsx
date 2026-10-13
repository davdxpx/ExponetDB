import { Alert, AlertDescription, AlertTitle, Button, Textarea } from '@exponetdb/ui'
import { FormLayout } from '@exponetdb/ui-patterns'
import { type FormEvent, type ReactNode, useState } from 'react'
import type { DemoDefinition } from '../types.ts'
import { Outcome } from './support.tsx'

const REASON_LIMIT = 1000

/**
 * Every audit `reason` field says, next to the field and linked to it, that the text is kept
 * permanently and must not hold personal data. The warning is the field's description, so a
 * screen reader announces it with the field.
 */
function AuditReasonField(): ReactNode {
  const [reason, setReason] = useState('')
  const [message, setMessage] = useState('')

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    setMessage('Plan rejected. The reason is now part of the audit log.')
    setReason('')
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Reject a plan" className="max-w-lg">
      <div className="flex flex-col gap-4">
        <FormLayout
          layout="vertical"
          label="Reason for rejecting"
          labelOptional="Optional"
          description="This reason is kept permanently in the audit log. Do not enter personal data."
          afterLabel={
            <span className="text-xs text-foreground-lighter">
              {reason.length} of {REASON_LIMIT}
            </span>
          }
        >
          {(control) => (
            <Textarea
              {...control}
              maxLength={REASON_LIMIT}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value)
                setMessage('')
              }}
            />
          )}
        </FormLayout>
        <div>
          <Button type="submit" variant="danger">
            Reject plan
          </Button>
        </div>
      </div>
      <Outcome>{message}</Outcome>
    </form>
  )
}

function Messages(): ReactNode {
  return (
    <div className="flex flex-col gap-3">
      <Alert variant="success">
        <AlertTitle>Plan created</AlertTitle>
        <AlertDescription>Review it before you apply it. It expires at 12:15 UTC.</AlertDescription>
      </Alert>
      <Alert variant="destructive">
        <AlertTitle>Could not create the plan</AlertTitle>
        <AlertDescription>
          The target is suspended. Resume the target, then create the plan again.{' '}
          <code className="font-mono text-xs">TARGET_SUSPENDED</code>
        </AlertDescription>
      </Alert>
      <Alert variant="warning">
        <AlertTitle>This plan applies to production</AlertTitle>
        <AlertDescription>
          It changes shop/platform/production. A person must approve it first.
        </AlertDescription>
      </Alert>
      <Alert variant="info">
        <AlertTitle>Verification comes next</AlertTitle>
        <AlertDescription>
          Applied is not verified. The result appears here when verification finishes.
        </AlertDescription>
      </Alert>
    </div>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'guidance/copywriting/audit-reason',
    title: 'A reason field warns that the text is permanent and must not hold personal data',
    render: () => <AuditReasonField />,
  },
  {
    id: 'guidance/copywriting/messages',
    title: 'Messages name what happened and what to do next',
    render: () => <Messages />,
  },
]
