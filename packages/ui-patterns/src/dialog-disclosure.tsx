// Derived from supabase/supabase packages/ui-patterns/src/DialogDisclosure.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { ChevronDown } from '@exponetdb/icons'
import { Collapsible, CollapsibleContent, CollapsibleTrigger, cn } from '@exponetdb/ui'
import type { ComponentProps, ReactNode } from 'react'

type DialogDisclosureTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  icon?: ReactNode
}

/** A disclosure inside a dialog: a button with `aria-expanded` that shows or hides its content. */
export const DialogDisclosure: typeof Collapsible = Collapsible

export const DialogDisclosureTrigger = ({
  children,
  className,
  icon,
  ...props
}: DialogDisclosureTriggerProps) => (
  <CollapsibleTrigger
    className={cn(
      'group/trigger flex w-full cursor-pointer items-center justify-between gap-2 text-left text-sm text-foreground-light transition-colors hover:bg-muted hover:text-foreground motion-reduce:transition-none',
      className,
    )}
    {...props}
  >
    <span>{children}</span>
    <span aria-hidden="true" className="shrink-0">
      {icon ?? (
        <ChevronDown
          size={16}
          className="transition-transform group-data-[state=open]/trigger:rotate-180 motion-reduce:transition-none"
        />
      )}
    </span>
  </CollapsibleTrigger>
)

export const DialogDisclosureContent = ({
  className,
  ...props
}: ComponentProps<typeof CollapsibleContent>) => (
  <CollapsibleContent
    className={cn(
      '[overflow-y:clip] motion-reduce:animate-none data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down',
      className,
    )}
    {...props}
  />
)
