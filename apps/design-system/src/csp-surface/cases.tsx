import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Calendar,
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  chartColor,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  flattenTree,
  GapLine,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuList,
  NavigationMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Progress,
  RadioGroup,
  RadioGroupItem,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  Sidebar,
  SidebarContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  Skeleton,
  Slider,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableHeadSort,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Toaster,
  ToggleGroup,
  ToggleGroupItem,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  TreeView,
  TreeViewItem,
  toast,
} from '@exponetdb/ui'
import { MarkedCode, UntrustedName, UntrustedText } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { CartesianGrid, LineChart, XAxis, YAxis } from 'recharts'

/**
 * The cases of the CSP surface: every primitive that could inject a style element, evaluate
 * code or load a resource, rendered in its interactive state (overlays open, viewports
 * scrolled, indicators measured, toasts shown). The browser test visits each case under the
 * production policy and fails on any violation. Add a case for every new primitive or pattern
 * that renders overlays, measures layout, animates or draws.
 */
export interface CspCase {
  readonly id: string
  readonly title: string
  readonly render: () => ReactNode
  /** Runs after the first frame (opens what has no `open` prop, scrolls, shows toasts). */
  readonly act?: () => void | Promise<void>
}

const noop = (): void => {}

/** Right-to-left letters inside SQL: a hostile statement whose visual order must stay logical. */
export const BIDI_PROBE_TEXT = 'UPDATE accounts SET amount = 1 /*\u{5D0}*/ + 99 --\u{5D1}'

function scrollAll(selector: string): void {
  for (const element of document.querySelectorAll(selector)) {
    element.scrollTop = 200
    element.scrollLeft = 200
  }
}

const rows = Array.from({ length: 40 }, (_, i) => `Row ${i + 1}`)

const chartConfig = {
  connections: { label: 'Connections', color: chartColor(1) },
  waiting: { label: 'Waiting', color: chartColor(2) },
} satisfies ChartConfig

const chartData = [
  { t: '12:00', connections: 12, waiting: 1 },
  { t: '12:05', connections: 18, waiting: 3 },
  { t: '12:10', connections: null, waiting: null },
  { t: '12:15', connections: 21, waiting: 2 },
  { t: '12:20', connections: 16, waiting: 0 },
]

const tree = flattenTree({
  name: '',
  children: [
    { name: 'public', children: [{ name: 'orders' }, { name: 'customers' }] },
    { name: 'exponetdb', children: [{ name: 'ledger' }] },
  ],
})

export const CSP_CASES: readonly CspCase[] = [
  {
    id: 'dialog',
    title: 'Dialog (modal, scroll lock)',
    render: () => (
      <Dialog defaultOpen>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename target</DialogTitle>
            <DialogDescription>The path stays the same.</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    ),
  },
  {
    id: 'alert-dialog',
    title: 'Alert dialog (modal, scroll lock)',
    render: () => (
      <AlertDialog defaultOpen>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Withdraw plan?</AlertDialogTitle>
            <AlertDialogDescription>The plan can no longer be applied.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep plan</AlertDialogCancel>
            <AlertDialogAction onClick={noop}>Withdraw plan</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    ),
  },
  {
    id: 'sheet',
    title: 'Sheet (modal, scroll lock)',
    render: () => (
      <Sheet defaultOpen>
        <SheetContent>
          <SheetTitle>Operation details</SheetTitle>
          <SheetDescription>Steps and outcome.</SheetDescription>
        </SheetContent>
      </Sheet>
    ),
  },
  {
    id: 'popover-modal',
    title: 'Popover (modal)',
    render: () => (
      <Popover defaultOpen modal>
        <PopoverTrigger asChild>
          <Button>Filters</Button>
        </PopoverTrigger>
        <PopoverContent>Filter by tier and state.</PopoverContent>
      </Popover>
    ),
  },
  {
    id: 'dropdown-menu-modal',
    title: 'Dropdown menu (modal)',
    render: () => (
      <DropdownMenu defaultOpen modal>
        <DropdownMenuTrigger asChild>
          <Button>Actions</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Copy path</DropdownMenuItem>
          <DropdownMenuItem>Open audit</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ),
  },
  {
    id: 'context-menu',
    title: 'Context menu (modal, opened by a contextmenu event)',
    render: () => (
      <ContextMenu>
        <ContextMenuTrigger className="block h-24 w-64 border border-default" data-case-trigger>
          Right-click here
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Copy name</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    ),
    act: () => {
      const trigger = document.querySelector('[data-case-trigger]')
      trigger?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }),
      )
    },
  },
  {
    id: 'hover-card',
    title: 'Hover card',
    render: () => (
      <HoverCard defaultOpen>
        <HoverCardTrigger asChild>
          <Button variant="link">reos-01</Button>
        </HoverCardTrigger>
        <HoverCardContent>Agent 0.9.0, heartbeat 12 s ago.</HoverCardContent>
      </HoverCard>
    ),
  },
  {
    id: 'tooltip',
    title: 'Tooltip',
    render: () => (
      <TooltipProvider>
        <Tooltip defaultOpen>
          <TooltipTrigger asChild>
            <Button>Plan hash</Button>
          </TooltipTrigger>
          <TooltipContent>Copy the full plan hash</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    ),
  },
  {
    id: 'select',
    title: 'Select (viewport style, scroll lock)',
    render: () => (
      <Select defaultOpen defaultValue="staging">
        <SelectTrigger aria-label="Environment">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {['development', 'staging', 'production', ...rows].map((value) => (
            <SelectItem key={value} value={value}>
              {value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ),
    act: () => scrollAll('[data-radix-select-viewport]'),
  },
  {
    id: 'scroll-area',
    title: 'Scroll area (viewport style)',
    render: () => (
      <ScrollArea className="h-40 w-64 border border-default">
        {rows.map((row) => (
          <p key={row} className="px-3 py-1">
            {row}
          </p>
        ))}
      </ScrollArea>
    ),
    act: () => scrollAll('[data-radix-scroll-area-viewport]'),
  },
  {
    id: 'command',
    title: 'Command list (cmdk)',
    render: () => (
      <Command label="Commands" className="w-80 border border-default">
        <CommandInput placeholder="Search commands" />
        <CommandList>
          <CommandEmpty>No command matches.</CommandEmpty>
          <CommandGroup heading="Go to">
            <CommandItem>Plans</CommandItem>
            <CommandItem>Approvals</CommandItem>
            <CommandItem>Audit</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    ),
  },
  {
    id: 'command-dialog',
    title: 'Command dialog (modal)',
    render: () => (
      <CommandDialog open title="Command menu" description="Search for a command">
        <CommandInput placeholder="Search commands" />
        <CommandList>
          <CommandGroup heading="Go to">
            <CommandItem>Targets</CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    ),
  },
  {
    id: 'input-otp',
    title: 'One-time code input (input-otp)',
    render: () => (
      <InputOTP maxLength={6} autoFocus aria-label="Code from the terminal">
        <InputOTPGroup>
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <InputOTPSlot key={index} index={index} />
          ))}
        </InputOTPGroup>
      </InputOTP>
    ),
  },
  {
    id: 'calendar',
    title: 'Calendar (react-day-picker)',
    render: () => <Calendar mode="single" defaultMonth={new Date(Date.UTC(2026, 9, 1))} />,
  },
  {
    id: 'chart',
    title: 'Chart (recharts, colors through CSSOM, a gap)',
    render: () => (
      <ChartContainer config={chartConfig} className="h-64 w-[32rem]">
        <LineChart data={chartData} accessibilityLayer>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="t" />
          <YAxis />
          <ChartTooltip defaultIndex={1} active content={<ChartTooltipContent />} />
          <GapLine dataKey="connections" stroke="var(--color-connections)" />
          <GapLine dataKey="waiting" stroke="var(--color-waiting)" />
        </LineChart>
      </ChartContainer>
    ),
  },
  {
    id: 'resizable',
    title: 'Resizable panels (constructable stylesheet for the cursor)',
    render: () => (
      <ResizablePanelGroup
        orientation="horizontal"
        className="h-40 w-[32rem] border border-default"
      >
        <ResizablePanel defaultSize="40%">Schema</ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize="60%">Definition</ResizablePanel>
      </ResizablePanelGroup>
    ),
    act: () => {
      const handle = document.querySelector<HTMLElement>('[role="separator"]')
      handle?.focus()
      handle?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    },
  },
  {
    id: 'sidebar',
    title: 'Sidebar (expand on hover, collapsed)',
    render: () => (
      <SidebarProvider defaultOpen={false}>
        <Sidebar collapsible="icon" expandOnHover>
          <SidebarContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton tooltip="Targets">Targets</SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarContent>
        </Sidebar>
      </SidebarProvider>
    ),
  },
  {
    id: 'tabs',
    title: 'Tabs (indicator through CSSOM)',
    render: () => (
      <Tabs defaultValue="steps">
        <TabsList>
          <TabsTrigger value="summary">Summary</TabsTrigger>
          <TabsTrigger value="steps">Steps</TabsTrigger>
          <TabsTrigger value="evidence">Evidence</TabsTrigger>
        </TabsList>
        <TabsContent value="steps">Three steps.</TabsContent>
      </Tabs>
    ),
  },
  {
    id: 'toggle-group',
    title: 'Toggle group (segmented indicator)',
    render: () => (
      <ToggleGroup type="single" defaultValue="hour" aria-label="Range">
        <ToggleGroupItem value="hour">1 h</ToggleGroupItem>
        <ToggleGroupItem value="day">24 h</ToggleGroupItem>
        <ToggleGroupItem value="week">7 d</ToggleGroupItem>
      </ToggleGroup>
    ),
  },
  {
    id: 'toast',
    title: 'Toasts (Radix Toast)',
    render: () => <Toaster />,
    act: () => {
      toast.success('Plan created')
      toast.warning('The newest backup is not known')
      toast.error('Could not reach the server', { code: 'SERVICE_UNAVAILABLE' })
    },
  },
  {
    id: 'tree-view',
    title: 'Tree view',
    render: () => (
      <TreeView
        data={tree}
        aria-label="Schemas"
        defaultExpandedIds={[1, 4]}
        nodeRenderer={({ element, getNodeProps, level, isBranch, isExpanded }) => (
          <TreeViewItem
            {...getNodeProps()}
            level={level}
            name={element.name}
            isBranch={isBranch}
            isExpanded={isExpanded}
          />
        )}
      />
    ),
  },
  {
    id: 'disclosures',
    title: 'Accordion, collapsible, navigation menu (open)',
    render: () => (
      <div className="flex flex-col gap-6">
        <Accordion type="single" defaultValue="a" collapsible>
          <AccordionItem value="a">
            <AccordionTrigger>Locks</AccordionTrigger>
            <AccordionContent>ACCESS EXCLUSIVE on orders.</AccordionContent>
          </AccordionItem>
        </Accordion>
        <Collapsible defaultOpen>
          <CollapsibleTrigger asChild>
            <Button>Statements</Button>
          </CollapsibleTrigger>
          <CollapsibleContent>Two statements.</CollapsibleContent>
        </Collapsible>
        <NavigationMenu defaultValue="changes" aria-label="Sections">
          <NavigationMenuList>
            <NavigationMenuItem value="changes">
              <NavigationMenuTrigger>Changes</NavigationMenuTrigger>
              <NavigationMenuContent>Plans and operations</NavigationMenuContent>
            </NavigationMenuItem>
          </NavigationMenuList>
        </NavigationMenu>
      </div>
    ),
  },
  {
    id: 'controls',
    title: 'Form controls (slider, switch, checkbox, radio, progress, skeleton)',
    render: () => (
      <div className="flex w-80 flex-col gap-4">
        <Slider defaultValue={[30]} aria-label="Sample rate" />
        <Switch aria-label="Notify" defaultChecked />
        <Checkbox aria-label="Include system schemas" checked="indeterminate" />
        <RadioGroup defaultValue="a" aria-label="Scope">
          <RadioGroupItem value="a" aria-label="Target" />
          <RadioGroupItem value="b" aria-label="Cluster" />
        </RadioGroup>
        <Progress aria-label="Verifying" />
        <Skeleton className="h-6 w-40" />
      </div>
    ),
  },
  {
    id: 'table',
    title: 'Table with a sorted header',
    render: () => (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <TableHeadSort column="name" currentSort="name:asc" onSortChange={noop}>
                Name
              </TableHeadSort>
            </TableHead>
            <TableHead>Tier</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>exponet/platform/production</TableCell>
            <TableCell>production</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    ),
  },
  {
    id: 'untrusted-bidi',
    title: 'Untrusted text, name and marked code with right-to-left letters',
    render: () => (
      <div className="flex flex-col gap-4">
        <div data-bidi-probe="text">
          <UntrustedText text={BIDI_PROBE_TEXT} mono />
        </div>
        <div data-bidi-probe="name">
          <UntrustedName name={BIDI_PROBE_TEXT} maxCodePoints={200} />
        </div>
        <div data-bidi-probe="code">
          <MarkedCode text={BIDI_PROBE_TEXT} />
        </div>
      </div>
    ),
  },
]

export function findCase(id: string): CspCase | undefined {
  return CSP_CASES.find((c) => c.id === id)
}
