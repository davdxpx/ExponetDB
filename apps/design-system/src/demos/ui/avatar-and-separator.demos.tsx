import { Avatar, AvatarFallback, Separator } from '@exponetdb/ui'
import { UntrustedName } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import type { DemoDefinition } from '../types.ts'
import { Row, Stack } from './support.tsx'

/**
 * The initials of a name that may come from outside: invisible and direction characters are
 * dropped first, then the first letter of up to two words is taken by code point.
 */
function initialsOf(name: string): string {
  const visible = name.replace(/[\p{Cf}\p{Cc}\p{Zl}\p{Zp}]/gu, '')
  const words = visible.split(/\s+/u).filter((word) => word !== '')
  const letters = words.slice(0, 2).map((word) => Array.from(word)[0] ?? '')
  return letters.join('').toUpperCase()
}

function Avatars(): ReactNode {
  return (
    <Row>
      <Avatar className="size-6">
        <AvatarFallback className="text-[10px]" role="img" aria-label="Dana Okafor">
          DO
        </AvatarFallback>
      </Avatar>
      <Avatar>
        <AvatarFallback className="text-sm" role="img" aria-label="Dana Okafor">
          DO
        </AvatarFallback>
      </Avatar>
      <Avatar className="size-14">
        <AvatarFallback className="text-lg" role="img" aria-label="Dana Okafor">
          DO
        </AvatarFallback>
      </Avatar>
    </Row>
  )
}

const CLIENTS = ['Dana Okafor', 'deploy bot', 'a\u{200B}dmin \u{202E}toor', 'ci'] as const

function PersonRow({ name }: { readonly name: string }): ReactNode {
  return (
    <li className="flex items-center gap-3">
      <Avatar className="size-8">
        <AvatarFallback className="text-xs" aria-hidden>
          {initialsOf(name)}
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0 text-sm">
        <UntrustedName name={name} />
      </span>
    </li>
  )
}

function Initials(): ReactNode {
  return (
    <ul aria-label="Clients" className="flex max-w-sm flex-col gap-2">
      {CLIENTS.map((name) => (
        <PersonRow key={name} name={name} />
      ))}
    </ul>
  )
}

function Separators(): ReactNode {
  return (
    <Stack className="max-w-sm">
      <div className="flex flex-col gap-2">
        <p className="text-sm text-foreground">Plan for shop/platform/staging</p>
        <Separator />
        <p className="text-sm text-foreground-light">Created 12 minutes ago by Dana Okafor.</p>
      </div>
      <div className="flex h-5 items-center gap-3 text-sm">
        <span>Plans</span>
        <Separator orientation="vertical" />
        <span>Operations</span>
        <Separator orientation="vertical" />
        <span>Approvals</span>
      </div>
    </Stack>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui/avatar-and-separator/avatars',
    title: 'Avatars with initials, in three sizes',
    render: () => <Avatars />,
  },
  {
    id: 'ui/avatar-and-separator/initials',
    title: 'Initials from names that may contain hidden characters',
    render: () => <Initials />,
  },
  {
    id: 'ui/avatar-and-separator/separators',
    title: 'Horizontal and vertical separators',
    render: () => <Separators />,
  },
]
