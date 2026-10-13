import {
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  AlertTitle,
  Button,
} from '@exponetdb/ui'
import { type ReactNode, useState } from 'react'
import type { DemoDefinition } from '../types.ts'
import { Row, Stack } from './support.tsx'

function Confirm(): ReactNode {
  const [done, setDone] = useState(false)
  return (
    <Row>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="danger">Withdraw plan</Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Withdraw this plan?</AlertDialogTitle>
            <AlertDialogDescription>
              The plan for shop/platform/staging can no longer be approved or applied. You can
              create a new plan.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep plan</AlertDialogCancel>
            <AlertDialogAction variant="danger" onClick={() => setDone(true)}>
              Withdraw plan
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {done ? (
        <p role="status" className="text-sm text-foreground-light">
          The plan was withdrawn.
        </p>
      ) : null}
    </Row>
  )
}

/** A request that takes a moment and either succeeds or is refused. */
function request(outcome: 'succeeds' | 'fails'): Promise<void> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (outcome === 'succeeds') resolve()
      else reject(new Error('PLAN_STALE'))
    }, 800)
  })
}

function Pending({ outcome }: { readonly outcome: 'succeeds' | 'fails' }): ReactNode {
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  return (
    <Stack>
      <AlertDialog
        onOpenChange={(open) => {
          if (open) {
            setError(null)
            setResult(null)
          }
        }}
      >
        <AlertDialogTrigger asChild>
          <Button variant="default">Apply to production ({outcome})</Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply to production?</AlertDialogTitle>
            <AlertDialogDescription>
              This changes shop/platform/production. The plan was reviewed and approved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error === null ? null : (
            <AlertDialogBody>
              <Alert variant="destructive">
                <AlertTitle>Could not apply the plan</AlertTitle>
                <AlertDescription>
                  The plan is stale: the target changed after it was created. Error code {error}.
                </AlertDescription>
              </Alert>
            </AlertDialogBody>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="primary"
              onClick={() => request(outcome).then(() => setResult('The plan was applied.'))}
              onActionError={(reason) => setError(reason instanceof Error ? reason.message : '')}
            >
              Apply to production
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {result === null ? null : (
        <p role="status" className="text-sm text-foreground-light">
          {result}
        </p>
      )}
    </Stack>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui/alert-dialog/confirm',
    title: 'A confirmation with the safe choice first',
    render: () => <Confirm />,
    visual: false,
  },
  {
    id: 'ui/alert-dialog/pending-succeeds',
    title: 'A pending action keeps the dialog open, then closes it',
    render: () => <Pending outcome="succeeds" />,
    visual: false,
  },
  {
    id: 'ui/alert-dialog/pending-fails',
    title: 'A refused action keeps the dialog open and shows the failure inside it',
    render: () => <Pending outcome="fails" />,
    visual: false,
  },
]
