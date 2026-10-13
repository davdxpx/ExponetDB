import {
  Database,
  DatabaseBackup,
  GitCompareArrows,
  LayoutDashboard,
  ScrollText,
  Server,
  Settings,
  Users,
} from '@exponetdb/icons'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from '@exponetdb/ui'
import type { ReactNode } from 'react'
import type { DemoDefinition } from '../types.ts'

function Frame({ children }: { readonly children: ReactNode }): ReactNode {
  return <div className="overflow-hidden rounded-md border border-default">{children}</div>
}

function State(): ReactNode {
  const { state, open } = useSidebar()
  return (
    <p role="status" className="text-xs text-foreground-lighter">
      Sidebar {state}, saved as {open ? 'open' : 'collapsed'}.
    </p>
  )
}

function Content({ withSub }: { readonly withSub: boolean }): ReactNode {
  return (
    <>
      <SidebarHeader>
        <p className="px-2 text-sm font-medium group-data-[collapsible=icon]:hidden">ExponetDB</p>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Sections">
          <SidebarGroup>
            <SidebarGroupLabel>Fleet</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton isActive tooltip="Overview">
                    <LayoutDashboard aria-hidden />
                    <span>Overview</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton tooltip="Databases">
                    <Database aria-hidden />
                    <span>Databases</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton tooltip="Changes">
                    <GitCompareArrows aria-hidden />
                    <span>Changes</span>
                  </SidebarMenuButton>
                  <SidebarMenuBadge>3</SidebarMenuBadge>
                  {withSub ? (
                    <SidebarMenuSub>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton asChild isActive>
                          <button type="button">Plans</button>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton asChild>
                          <button type="button">Operations</button>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    </SidebarMenuSub>
                  ) : null}
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton tooltip="Infrastructure">
                    <Server aria-hidden />
                    <span>Infrastructure</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton tooltip="Backups">
                    <DatabaseBackup aria-hidden />
                    <span>Backups</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarSeparator />
          <SidebarGroup>
            <SidebarGroupLabel>Administration</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton tooltip="Access">
                    <Users aria-hidden />
                    <span>Access</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton tooltip="Audit">
                    <ScrollText aria-hidden />
                    <span>Audit</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </nav>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Settings">
              <Settings aria-hidden />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  )
}

function Expanded(): ReactNode {
  return (
    <Frame>
      <SidebarProvider className="h-96 min-h-0">
        <Sidebar collapsible="icon" label="Sections">
          <Content withSub />
        </Sidebar>
        <div className="flex flex-1 flex-col gap-2 p-3">
          <SidebarTrigger />
          <State />
          <p className="text-sm text-foreground-light">
            Press the toggle to collapse the sidebar to its icons. Below 768 px wide the sidebar is
            a sheet instead.
          </p>
        </div>
      </SidebarProvider>
    </Frame>
  )
}

function Collapsed(): ReactNode {
  return (
    <Frame>
      <SidebarProvider defaultOpen={false} className="h-96 min-h-0">
        <Sidebar collapsible="icon" label="Sections">
          <Content withSub={false} />
        </Sidebar>
        <div className="flex flex-1 flex-col gap-2 p-3">
          <SidebarTrigger />
          <State />
          <p className="text-sm text-foreground-light">
            Collapsed, each entry shows its name in a tooltip on hover and on focus.
          </p>
        </div>
      </SidebarProvider>
    </Frame>
  )
}

function OnHover(): ReactNode {
  return (
    <Frame>
      <SidebarProvider defaultOpen={false} className="h-96 min-h-0">
        <Sidebar collapsible="icon" expandOnHover label="Sections">
          <Content withSub={false} />
        </Sidebar>
        <div className="flex flex-1 flex-col gap-2 p-3">
          <State />
          <p className="text-sm text-foreground-light">
            The sidebar keeps its icon width in the layout and opens over the page while the pointer
            is on it or focus is inside. The page does not move.
          </p>
        </div>
      </SidebarProvider>
    </Frame>
  )
}

function Entries(): ReactNode {
  return (
    <Frame>
      <SidebarProvider className="h-64 min-h-0">
        <Sidebar collapsible="none" label="Sections">
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu aria-label="States of an entry">
                  <SidebarMenuItem>
                    <SidebarMenuButton isActive>
                      <LayoutDashboard aria-hidden />
                      <span>Active</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton>
                      <Database aria-hidden />
                      <span>Enabled</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      disabled
                      focusableWhenDisabled
                      tooltip="Ask an owner for the Backups permission."
                    >
                      <DatabaseBackup aria-hidden />
                      <span>Disabled, with a reason</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  {/* The library derives a width from a generated id; the demo fixes it so that it never drifts. */}
                  <SidebarMenuItem>
                    <SidebarMenuSkeleton
                      showIcon
                      className="[&_[data-sidebar=menu-skeleton-text]]:max-w-[70%]"
                    />
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuSkeleton
                      showIcon
                      className="[&_[data-sidebar=menu-skeleton-text]]:max-w-[55%]"
                    />
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
        <div className="flex-1 p-3">
          <p className="text-sm text-foreground-light">
            The last two rows are skeletons for entries that are still loading.
          </p>
        </div>
      </SidebarProvider>
    </Frame>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui/sidebar/expanded',
    title: 'An expanded sidebar with groups, a badge, a submenu and a footer',
    render: () => <Expanded />,
  },
  {
    id: 'ui/sidebar/collapsed',
    title: 'Collapsed to icons: each entry has a tooltip',
    render: () => <Collapsed />,
  },
  {
    id: 'ui/sidebar/on-hover',
    title: 'Expand on hover: the page does not move',
    render: () => <OnHover />,
  },
  {
    id: 'ui/sidebar/entries',
    title: 'Active, enabled, disabled with a reason, and loading entries',
    render: () => <Entries />,
  },
]
