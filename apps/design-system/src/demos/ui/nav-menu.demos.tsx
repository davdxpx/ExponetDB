import { Database, GitCompareArrows, Settings } from '@exponetdb/icons'
import {
  Menu,
  MenuGroup,
  MenuItem,
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
  NavMenu,
  NavMenuItem,
  navigationMenuTriggerStyle,
} from '@exponetdb/ui'
import { useLinkComponent } from '@exponetdb/ui-patterns'
import { type ReactNode, useState } from 'react'
import type { DemoDefinition } from '../types.ts'

function SubNavigation(): ReactNode {
  const Link = useLinkComponent()
  const sections = ['Overview', 'Plans', 'Operations', 'Approvals'] as const
  return (
    <NavMenu aria-label="Changes" className="max-w-xl">
      {sections.map((section) => (
        <NavMenuItem
          key={section}
          active={section === 'Plans'}
          href="/ui/nav-menu"
          linkComponent={Link}
        >
          {section}
        </NavMenuItem>
      ))}
    </NavMenu>
  )
}

function Menus(): ReactNode {
  const [active, setActive] = useState('General')
  return (
    <div className="grid gap-6 sm:grid-cols-3">
      {(['text', 'border', 'pills'] as const).map((type) => (
        <Menu key={type} type={type} aria-label={`Settings, ${type} style`} className="w-48">
          <MenuGroup title="Settings" icon={<Settings aria-hidden className="size-4" />}>
            {['General', 'Policies', 'Notifications'].map((item) => (
              <MenuItem
                key={item}
                active={active === item}
                onClick={() => setActive(item)}
                icon={
                  item === 'Policies' ? (
                    <GitCompareArrows aria-hidden className="size-4" />
                  ) : item === 'General' ? (
                    <Database aria-hidden className="size-4" />
                  ) : undefined
                }
              >
                {item}
              </MenuItem>
            ))}
          </MenuGroup>
        </Menu>
      ))}
    </div>
  )
}

function Disclosure(): ReactNode {
  return (
    <NavigationMenu aria-label="Reference" renderViewport={false}>
      <NavigationMenuList>
        <NavigationMenuItem>
          <NavigationMenuTrigger className={navigationMenuTriggerStyle()}>
            Reference
          </NavigationMenuTrigger>
          <NavigationMenuContent className="w-64 rounded-md border border-default bg-overlay p-2">
            <ul className="flex flex-col gap-1 text-sm">
              <li>
                <NavigationMenuLink
                  href="/ui/nav-menu"
                  className="block rounded-item p-2 hover:bg-accent"
                >
                  Error codes
                </NavigationMenuLink>
              </li>
              <li>
                <NavigationMenuLink
                  href="/ui/nav-menu"
                  className="block rounded-item p-2 hover:bg-accent"
                >
                  Capabilities
                </NavigationMenuLink>
              </li>
            </ul>
          </NavigationMenuContent>
        </NavigationMenuItem>
      </NavigationMenuList>
    </NavigationMenu>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui/nav-menu/sub-navigation',
    title: 'Sub-navigation of a section: a nav landmark of links',
    render: () => <SubNavigation />,
  },
  {
    id: 'ui/nav-menu/menu',
    title: 'A vertical menu in three styles',
    render: () => <Menus />,
  },
  {
    id: 'ui/nav-menu/disclosure',
    title: 'A disclosure navigation menu (open it to see the links)',
    render: () => <Disclosure />,
    visual: false,
  },
]
