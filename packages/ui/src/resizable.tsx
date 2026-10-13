// Derived from supabase/supabase packages/ui/src/components/shadcn/ui/resizable.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { GripVertical } from '@exponetdb/icons'
import * as ResizablePrimitive from 'react-resizable-panels'

import { cn } from './lib/utils.ts'

/**
 * A group of resizable panels (react-resizable-panels 4). The group lays its panels out with its
 * own inline styles. Saving the layout is the app's job: pass `defaultLayout` and save from
 * `onLayoutChanged`, or use `useResizableLayout` with the app's own storage.
 */
const ResizablePanelGroup = ({ className, ...props }: ResizablePrimitive.GroupProps) => {
  return (
    <ResizablePrimitive.Group
      className={cn('flex h-full w-full', className)}
      data-slot="resizable-panel-group"
      {...props}
    />
  )
}

const ResizablePanel = ({ ...props }: ResizablePrimitive.PanelProps) => {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />
}

/**
 * The divider between two panels. It is a focusable `role="separator"` that exposes its position
 * (`aria-valuenow`) and resizes with the arrow keys, Home and End; the label says which panels it
 * resizes, so pass a specific one where the layout has more than one handle.
 */
const ResizableHandle = ({
  withHandle,
  className,
  'aria-label': ariaLabel = 'Resize panels',
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean
}) => {
  return (
    <ResizablePrimitive.Separator
      aria-label={ariaLabel}
      className={cn(
        'relative flex w-px items-center justify-center bg-border after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-ring aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:-translate-y-1/2 aria-[orientation=horizontal]:after:translate-x-0 [&[aria-orientation=horizontal]>div]:rotate-90',
        'data-[separator=active]:bg-border-strong',
        'group',
        'transition-colors motion-reduce:transition-none',
        className,
      )}
      {...props}
    >
      {withHandle && (
        <div
          aria-hidden="true"
          className={cn(
            'z-10 flex h-4 w-3 items-center justify-center rounded-xs border bg-border focus:bg-surface-400',
            'opacity-0 transition-opacity duration-200 motion-reduce:transition-none',
            'group-focus-visible:opacity-100',
            'group-data-[separator=hover]:opacity-100',
            'hover:bg-surface-400',
            'group-data-[separator=active]:opacity-100',
            'group-data-[separator=active]:bg-foreground-muted',
          )}
        >
          <GripVertical className="h-2.5 w-2.5" />
        </div>
      )}
    </ResizablePrimitive.Separator>
  )
}

/**
 * The saved layout of a group, read from and written to a storage the app names. The library
 * would fall back to the browser's local storage; here the storage is required, so a layout is
 * only saved where the app has decided to save it.
 */
function useResizableLayout(options: {
  id: string
  storage: ResizablePrimitive.LayoutStorage
  panelIds?: string[]
  onlySaveAfterUserInteractions?: boolean
}) {
  return ResizablePrimitive.useDefaultLayout(options)
}

const usePanelRef = ResizablePrimitive.usePanelRef
const useGroupRef = ResizablePrimitive.useGroupRef

export {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  useGroupRef,
  usePanelRef,
  useResizableLayout,
}
