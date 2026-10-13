// Derived from supabase/supabase packages/ui/src/components/shadcn/ui/accordion.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { ChevronDown } from '@exponetdb/icons'
import { Accordion as AccordionPrimitive } from 'radix-ui'
import * as React from 'react'
import { getExplicitTabIndex } from './lib/get-explicit-tab-index.ts'
import { cn } from './lib/utils.ts'

const Accordion = AccordionPrimitive.Root

const AccordionItem = React.forwardRef<
  React.ComponentRef<typeof AccordionPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Item>
>(({ className, ...props }, ref) => (
  <AccordionPrimitive.Item ref={ref} className={cn('border-b', className)} {...props} />
))
AccordionItem.displayName = 'AccordionItem'

const AccordionTrigger = React.forwardRef<
  React.ComponentRef<typeof AccordionPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Trigger> & {
    focusVariant?: 'ring' | 'inset'
    hideIcon?: boolean
    /** The level of the heading that wraps the trigger, so it fits the page outline. */
    headingLevel?: 2 | 3 | 4 | 5 | 6
  }
>(
  (
    {
      className,
      children,
      focusVariant = 'inset',
      hideIcon,
      disabled,
      tabIndex,
      headingLevel = 3,
      ...props
    },
    ref,
  ) => {
    const computedTabIndex = getExplicitTabIndex(tabIndex, disabled)
    const Heading = `h${headingLevel}` as const

    return (
      <AccordionPrimitive.Header asChild>
        <Heading className="flex w-full">
          <AccordionPrimitive.Trigger
            ref={ref}
            className={cn(
              'cursor-pointer flex flex-1 gap-2 items-center justify-between py-4 text-left',
              'font-medium hover:underline',
              '[&[data-state=open]>svg]:rotate-180',
              focusVariant === 'ring' && 'rounded-md',
              className,
              focusVariant === 'ring' ? 'focus-ring' : 'relative focus-inset',
            )}
            {...props}
            disabled={disabled}
            tabIndex={computedTabIndex}
          >
            {children}
            {!hideIcon && (
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  'h-4 w-4 shrink-0',
                  'transition-transform duration-200',
                  'motion-reduce:transition-none motion-reduce:duration-0',
                )}
              />
            )}
          </AccordionPrimitive.Trigger>
        </Heading>
      </AccordionPrimitive.Header>
    )
  },
)
AccordionTrigger.displayName = 'AccordionTrigger'

const AccordionContent = React.forwardRef<
  React.ComponentRef<typeof AccordionPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <AccordionPrimitive.Content
    ref={ref}
    className={cn(
      'overflow-hidden text-sm',
      'transition-all motion-reduce:transition-none',
      'data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down',
      'motion-reduce:animate-none',
      className,
    )}
    {...props}
  >
    <div className="pb-4 pt-0">{children}</div>
  </AccordionPrimitive.Content>
))
AccordionContent.displayName = 'AccordionContent'

export { Accordion, AccordionContent, AccordionItem, AccordionTrigger }
