import {
  Button,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetSection,
  SheetTitle,
  SheetTrigger,
} from '@exponetdb/ui'
import { type ReactNode, useId, useState } from 'react'
import type { DemoDefinition } from '../types.ts'
import { Row, Stack } from './support.tsx'

function Register(): ReactNode {
  const pathId = useId()
  const clusterId = useId()
  return (
    <Row>
      <Sheet>
        <SheetTrigger asChild>
          <Button variant="primary">Register target</Button>
        </SheetTrigger>
        <SheetContent size="w656" className="flex flex-col gap-0 p-0">
          <SheetHeader>
            <SheetTitle>Register a target</SheetTitle>
            <SheetDescription>
              ExponetDB manages the database; it does not create it.
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto">
            <SheetSection>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={pathId} className="text-foreground-light">
                  Target path
                </Label>
                <Input id={pathId} placeholder="shop/platform/staging" />
              </div>
            </SheetSection>
            <SheetSection>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={clusterId} className="text-foreground-light">
                  Cluster
                </Label>
                <Input id={clusterId} placeholder="pg-main" />
              </div>
            </SheetSection>
          </div>
          <SheetFooter>
            <SheetClose asChild>
              <Button variant="default">Cancel</Button>
            </SheetClose>
            <Button variant="primary">Create plan</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </Row>
  )
}

const SIDES = ['right', 'left', 'top', 'bottom'] as const
type Side = (typeof SIDES)[number]

function SideOption({ side }: { readonly side: Side }): ReactNode {
  const id = useId()
  return (
    <div className="flex items-center gap-2">
      <RadioGroupItem id={id} value={side} />
      <Label htmlFor={id}>{side}</Label>
    </div>
  )
}

function Sides(): ReactNode {
  const [side, setSide] = useState<Side>('right')
  const groupId = useId()
  return (
    <Stack>
      <div className="flex flex-col gap-2">
        <p id={groupId} className="text-sm font-medium text-foreground">
          Edge of the screen
        </p>
        <RadioGroup
          aria-labelledby={groupId}
          value={side}
          onValueChange={(next) => setSide(next as Side)}
          className="flex flex-wrap gap-4"
        >
          {SIDES.map((option) => (
            <SideOption key={option} side={option} />
          ))}
        </RadioGroup>
      </div>
      <div>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="default">Open from the {side}</Button>
          </SheetTrigger>
          <SheetContent side={side} size="sm">
            <SheetHeader>
              <SheetTitle>Operation details</SheetTitle>
              <SheetDescription>Steps, outcome and evidence.</SheetDescription>
            </SheetHeader>
            <SheetSection>
              <p className="text-sm text-foreground-light">Three steps ran. Verification passed.</p>
            </SheetSection>
          </SheetContent>
        </Sheet>
      </div>
    </Stack>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui/sheet/form',
    title: 'A side panel with a header, sections and a footer',
    render: () => <Register />,
    visual: false,
  },
  {
    id: 'ui/sheet/sides',
    title: 'The four edges',
    render: () => <Sides />,
    visual: false,
  },
]
