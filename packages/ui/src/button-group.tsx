// Derived from supabase/supabase packages/ui/src/components/shadcn/ui/button-group.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import * as React from 'react'

import { Button, type ButtonProps } from './button.tsx'
import { cn } from './lib/utils.ts'

interface ButtonGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode
}

type ButtonGroupItemProps = Omit<ButtonProps, 'variant'>

/** A vertical group of related buttons in one bordered box. Name it with `aria-label` when the buttons need a shared context. */
const ButtonGroup = React.forwardRef<HTMLDivElement, ButtonGroupProps>(
  ({ className, children, ...props }, ref) => {
    return (
      // A group of related buttons. <fieldset> would add form semantics and cascade `disabled` to all buttons.
      // biome-ignore lint/a11y/useSemanticElements: role=group on a div is the pattern for a button group
      <div
        ref={ref}
        role="group"
        className={cn(
          'flex flex-col items-stretch border border-control rounded-md overflow-hidden',
          className,
        )}
        {...props}
      >
        {children}
      </div>
    )
  },
)
ButtonGroup.displayName = 'ButtonGroup'

const ButtonGroupItem = React.forwardRef<HTMLButtonElement, ButtonGroupItemProps>(
  ({ className, ...props }, ref) => {
    return (
      <Button
        ref={ref}
        variant="text"
        className={cn(
          'h-auto py-2 rounded-none justify-start border-0 border-b border-border last:border-b-0',
          className,
        )}
        {...props}
      />
    )
  },
)
ButtonGroupItem.displayName = 'ButtonGroupItem'

export { ButtonGroup, ButtonGroupItem, type ButtonGroupItemProps, type ButtonGroupProps }
