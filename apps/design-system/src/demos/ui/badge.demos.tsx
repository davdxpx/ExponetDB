import { Badge, Button } from '@exponetdb/ui'
import { ClassificationBadge, StateBadge, TierChip } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import type { DemoDefinition } from '../types.ts'
import { Row, Specimen, Stack } from './support.tsx'

function Variants(): ReactNode {
  return (
    <Row className="items-start gap-6">
      <Specimen caption="default">
        <Badge>Beta</Badge>
      </Specimen>
      <Specimen caption="secondary">
        <Badge variant="secondary">12 targets</Badge>
      </Specimen>
      <Specimen caption="success">
        <Badge variant="success">Verified</Badge>
      </Specimen>
      <Specimen caption="warning">
        <Badge variant="warning">Needs review</Badge>
      </Specimen>
      <Specimen caption="destructive">
        <Badge variant="destructive">Destroys data</Badge>
      </Specimen>
    </Row>
  )
}

function InContext(): ReactNode {
  return (
    <Stack>
      <Row>
        <p className="text-sm text-foreground">Plan for shop/platform/staging</p>
        <Badge variant="warning">Needs review</Badge>
      </Row>
      <Row>
        <Button variant="default">
          Approvals <Badge variant="secondary">3</Badge>
        </Button>
      </Row>
      <p className="text-sm text-foreground-light">
        Tier, health and classification have their own components, which carry a word, a shape and,
        where it applies, a source and age:
      </p>
      <Row>
        <TierChip tier="prod" name="production" />
        <StateBadge state="degraded" />
        <ClassificationBadge classification="destructive" />
      </Row>
    </Stack>
  )
}

export const demos: readonly DemoDefinition[] = [
  { id: 'ui/badge/variants', title: 'The five variants', render: () => <Variants /> },
  {
    id: 'ui/badge/in-context',
    title: 'A badge in a heading and a button, and the components that replace it',
    render: () => <InContext />,
  },
]
