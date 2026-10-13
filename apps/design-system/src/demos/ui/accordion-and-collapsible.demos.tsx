import { ChevronDown } from '@exponetdb/icons'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@exponetdb/ui'
import { type ReactNode, useState } from 'react'
import type { DemoDefinition } from '../types.ts'

function Single(): ReactNode {
  return (
    <Accordion type="single" collapsible defaultValue="locks" className="max-w-xl">
      <AccordionItem value="locks">
        <AccordionTrigger headingLevel={3}>Lock analysis</AccordionTrigger>
        <AccordionContent>
          Takes SHARE UPDATE EXCLUSIVE on orders. Writes continue; another schema change on the same
          table waits.
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="statements">
        <AccordionTrigger headingLevel={3}>Statements (2)</AccordionTrigger>
        <AccordionContent>
          <ol className="list-decimal pl-5">
            <li>CREATE INDEX CONCURRENTLY orders_customer_id_idx ON orders (customer_id);</li>
            <li>ANALYZE orders;</li>
          </ol>
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="rollback">
        <AccordionTrigger headingLevel={3} disabled>
          Rollback (not available)
        </AccordionTrigger>
        <AccordionContent>There is no down script for this migration.</AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}

function Multiple(): ReactNode {
  return (
    <Accordion type="multiple" defaultValue={['a', 'b']} className="max-w-xl">
      <AccordionItem value="a">
        <AccordionTrigger headingLevel={3} focusVariant="ring">
          Step 1: check locks
        </AccordionTrigger>
        <AccordionContent>Passed.</AccordionContent>
      </AccordionItem>
      <AccordionItem value="b">
        <AccordionTrigger headingLevel={3} focusVariant="ring">
          Step 2: create index
        </AccordionTrigger>
        <AccordionContent>Applied in 4.2 seconds.</AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}

function Disclosure(): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="max-w-xl">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-foreground">2 more statements</p>
        <CollapsibleTrigger asChild>
          <Button variant="text" iconRight={<ChevronDown />}>
            {open ? 'Hide statements' : 'Show statements'}
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <ul className="mt-2 list-disc pl-5 text-sm text-foreground-light">
          <li>ANALYZE orders;</li>
          <li>REINDEX INDEX CONCURRENTLY orders_customer_id_idx;</li>
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui/accordion-and-collapsible/single',
    title: 'An accordion with one item open at a time',
    render: () => <Single />,
  },
  {
    id: 'ui/accordion-and-collapsible/multiple',
    title: 'An accordion where several items stay open',
    render: () => <Multiple />,
  },
  {
    id: 'ui/accordion-and-collapsible/collapsible',
    title: 'A collapsible with its own trigger',
    render: () => <Disclosure />,
  },
]
