import { Button, ScrollArea } from '@exponetdb/ui'
import type { ReactNode } from 'react'
import type { DemoDefinition } from '../types.ts'

const ROLES = Array.from({ length: 24 }, (_, index) => `role_${String(index + 1).padStart(2, '0')}`)

function Vertical(): ReactNode {
  return (
    <ScrollArea className="h-48 w-64 rounded-md border border-default">
      <ul aria-label="Roles" className="p-2">
        {ROLES.map((role) => (
          <li key={role}>
            <Button variant="text" className="w-full justify-start font-mono">
              {role}
            </Button>
          </li>
        ))}
      </ul>
    </ScrollArea>
  )
}

function Both(): ReactNode {
  return (
    <ScrollArea orientation="both" className="h-40 w-72 rounded-md border border-default">
      <div className="w-[48rem] p-2">
        {ROLES.slice(0, 12).map((role) => (
          <div key={role} className="flex items-center gap-3 py-0.5">
            <Button variant="text" className="font-mono">
              {role}
            </Button>
            <span className="whitespace-nowrap text-xs text-foreground-light">
              Granted by the migration engine to shop/platform/staging
            </span>
          </div>
        ))}
      </div>
    </ScrollArea>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui/scroll-area/vertical',
    title: 'A vertical scroll area whose content can be focused',
    render: () => <Vertical />,
  },
  {
    id: 'ui/scroll-area/both',
    title: 'Both scrollbars',
    render: () => <Both />,
  },
]
