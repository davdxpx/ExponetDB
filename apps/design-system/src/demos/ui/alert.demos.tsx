import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  StatusIcon,
  SuccessCheck,
} from '@exponetdb/ui'
import type { ReactNode } from 'react'
import type { DemoDefinition } from '../types.ts'
import { Row, Specimen, Stack } from './support.tsx'

function Variants(): ReactNode {
  return (
    <Stack className="max-w-xl">
      <Alert>
        <AlertTitle>Plan created</AlertTitle>
        <AlertDescription>The plan expires in 12 minutes.</AlertDescription>
      </Alert>
      <Alert variant="info">
        <AlertTitle>Reading from a cached copy</AlertTitle>
        <AlertDescription>The newest live read was 4 minutes ago.</AlertDescription>
      </Alert>
      <Alert variant="success">
        <AlertTitle>Applied and verified</AlertTitle>
        <AlertDescription>
          The migration ran on shop/platform/staging in 4.2 seconds.
        </AlertDescription>
      </Alert>
      <Alert variant="warning">
        <AlertTitle>Takes a lock on orders</AlertTitle>
        <AlertDescription>Writes to orders wait while the index is built.</AlertDescription>
      </Alert>
      <Alert variant="destructive">
        <AlertTitle>Could not apply the plan</AlertTitle>
        <AlertDescription>
          The target changed after the plan was created. Error code PLAN_STALE.
        </AlertDescription>
      </Alert>
    </Stack>
  )
}

function Layouts(): ReactNode {
  return (
    <Stack className="max-w-xl">
      <Alert variant="warning" icon={false}>
        <AlertTitle>No icon</AlertTitle>
        <AlertDescription>
          The icon is left out when the surroundings already say it.
        </AlertDescription>
      </Alert>
      <Alert variant="destructive">
        <AlertTitle>Could not read the target list</AlertTitle>
        <AlertDescription>
          <p>This does not mean there are no targets.</p>
          <div className="mt-2">
            <Button variant="default" size="tiny">
              Try again
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    </Stack>
  )
}

function Icons(): ReactNode {
  return (
    <Row className="items-start gap-6">
      {(['default', 'info', 'success', 'warning', 'destructive'] as const).map((variant) => (
        <Specimen key={variant} caption={variant}>
          <StatusIcon variant={variant} className="size-6" />
        </Specimen>
      ))}
      <Specimen caption="bare">
        <StatusIcon variant="warning" hideBackground className="size-5" />
      </Specimen>
      <Specimen caption="SuccessCheck">
        <SuccessCheck />
      </Specimen>
    </Row>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui/alert/variants',
    title: 'The five variants, each with a title and a description',
    render: () => <Variants />,
  },
  {
    id: 'ui/alert/layouts',
    title: 'Without an icon, and with an action',
    render: () => <Layouts />,
  },
  {
    id: 'ui/alert/icons',
    title: 'StatusIcon and SuccessCheck: a shape for each meaning',
    render: () => <Icons />,
  },
]
