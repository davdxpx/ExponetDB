import { Tabs, TabsContent, TabsIndicator, TabsList, TabsTrigger } from '@exponetdb/ui'
import type { ReactNode } from 'react'
import type { DemoDefinition } from '../types.ts'
import { Stack } from './support.tsx'

function WithIndicator(): ReactNode {
  return (
    <Tabs defaultValue="steps" className="max-w-xl">
      <TabsList aria-label="Plan sections">
        <TabsTrigger value="summary" className="px-3">
          Summary
        </TabsTrigger>
        <TabsTrigger value="steps" className="px-3">
          Steps
        </TabsTrigger>
        <TabsTrigger value="evidence" className="px-3">
          Evidence
        </TabsTrigger>
        <TabsIndicator />
      </TabsList>
      <TabsContent value="summary">
        <p className="text-sm text-foreground-light">One migration, standard class.</p>
      </TabsContent>
      <TabsContent value="steps">
        <p className="text-sm text-foreground-light">
          Three steps: lock check, create index, verify.
        </p>
      </TabsContent>
      <TabsContent value="evidence">
        <p className="text-sm text-foreground-light">
          Applied and verified on shop/platform/staging.
        </p>
      </TabsContent>
    </Tabs>
  )
}

function Plain(): ReactNode {
  return (
    <Stack>
      <Tabs defaultValue="plans" className="max-w-xl">
        <TabsList aria-label="Changes">
          <TabsTrigger value="plans" className="px-3">
            Plans (3)
          </TabsTrigger>
          <TabsTrigger value="operations" className="px-3">
            Operations (12)
          </TabsTrigger>
          <TabsTrigger value="archived" className="px-3" disabled>
            Archived
          </TabsTrigger>
        </TabsList>
        <TabsContent value="plans">
          <p className="text-sm text-foreground-light">Three plans are waiting.</p>
        </TabsContent>
        <TabsContent value="operations">
          <p className="text-sm text-foreground-light">Twelve operations in the last day.</p>
        </TabsContent>
      </Tabs>
    </Stack>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui/tabs/indicator',
    title: 'Tabs with the sliding indicator',
    render: () => <WithIndicator />,
  },
  {
    id: 'ui/tabs/plain',
    title: 'Tabs with counts and a disabled tab',
    render: () => <Plain />,
  },
]
