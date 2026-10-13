import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@exponetdb/ui'
import { TierChip, UntrustedName, useLinkComponent } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import type { DemoDefinition } from '../types.ts'
import { HOSTILE, Stack } from './support.tsx'

function Trail(): ReactNode {
  const Link = useLinkComponent()
  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link href="/ui/breadcrumb">Databases</Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link href="/ui/breadcrumb">shop</Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link href="/ui/breadcrumb">platform</Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>staging</BreadcrumbPage>
          <TierChip tier="nonprod" />
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  )
}

function Collapsed(): ReactNode {
  const Link = useLinkComponent()
  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link href="/ui/breadcrumb">Infrastructure</Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbEllipsis />
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link href="/ui/breadcrumb">pg-main</Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>Roles</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  )
}

function Untrusted(): ReactNode {
  const Link = useLinkComponent()
  return (
    <Stack>
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/ui/breadcrumb">Databases</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>
              <UntrustedName name={HOSTILE.bidi} maxCodePoints={40} />
            </BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    </Stack>
  )
}

export const demos: readonly DemoDefinition[] = [
  { id: 'ui/breadcrumb/trail', title: 'A target path as a trail', render: () => <Trail /> },
  {
    id: 'ui/breadcrumb/collapsed',
    title: 'A collapsed middle part',
    render: () => <Collapsed />,
  },
  {
    id: 'ui/breadcrumb/untrusted',
    title: 'A name from outside, through UntrustedName',
    render: () => <Untrusted />,
  },
]
