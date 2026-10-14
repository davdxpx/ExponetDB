// Derived from supabase/supabase packages/ui-patterns/src/CollapsibleCardSection.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { ChevronRight } from '@exponetdb/icons'
import { Collapsible, CollapsibleContent, CollapsibleTrigger, cn } from '@exponetdb/ui'
import type { PropsWithChildren, ReactNode } from 'react'

export type CollapsibleCardSectionProps = PropsWithChildren<{
  title: string
  description?: ReactNode
  defaultOpen?: boolean
}>

/**
 * A titled section the reader opens and closes. The trigger is a button with
 * `aria-expanded` that controls the content; the content is removed from the
 * accessibility tree while closed.
 */
export const CollapsibleCardSection = ({
  title,
  description,
  defaultOpen = false,
  children,
}: CollapsibleCardSectionProps) => (
  <Collapsible defaultOpen={defaultOpen}>
    <CollapsibleTrigger className="group/trigger flex items-center gap-1 eyebrow text-xs text-foreground-lighter transition hover:text-foreground-light data-[state=open]:text-foreground-light motion-reduce:transition-none">
      {title}
      <ChevronRight
        size={16}
        strokeWidth={1}
        aria-hidden="true"
        className="mr-2 transition group-hover/trigger:text-foreground-light group-data-[state=open]/trigger:rotate-90 motion-reduce:transition-none"
      />
    </CollapsibleTrigger>
    <CollapsibleContent
      className={cn(
        // pb-px keeps child borders/shadows from being clipped by overflow-y: clip
        '[overflow-y:clip] pt-2 pb-px motion-reduce:animate-none data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down',
      )}
    >
      {description && <p className="mb-6 text-xs text-foreground-lighter">{description}</p>}
      {children}
    </CollapsibleContent>
  </Collapsible>
)
