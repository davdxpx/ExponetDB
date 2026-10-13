// Derived from supabase/supabase packages/ui-patterns/src/Admonition/Admonition.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { Alert, AlertDescription, AlertTitle, cn } from '@exponetdb/ui'
import { type ComponentPropsWithoutRef, type ComponentRef, forwardRef } from 'react'

import { AdmonitionTypeIcon } from './admonition-icons.tsx'
import type { AdmonitionLayout, AdmonitionProps, AdmonitionType } from './admonition-types.ts'

export type { AdmonitionLayout, AdmonitionProps, AdmonitionType }

const admonitionBodyClassName = [
  'text-sm leading-relaxed [&_code]:text-xs',
  'mb-0 [&_p]:mt-0 [&_p]:mb-1.5 [&_p:last-child]:mb-0',
].join(' ')

/**
 * A callout inside a page or a dialog: an `Alert` of the UI package with an optional
 * title, a description, free content and actions. `destructive` is announced at once
 * (`role="alert"`), the other types are polite status messages. The title is plain text
 * (no Markdown, no HTML); the description and children are React nodes the caller built.
 */
export const Admonition = forwardRef<
  ComponentRef<typeof Alert>,
  Omit<
    ComponentPropsWithoutRef<typeof Alert>,
    keyof AdmonitionProps | 'children' | 'variant' | 'icon'
  > &
    AdmonitionProps
>(
  (
    {
      type = 'default',
      showIcon = true,
      title,
      description,
      children,
      layout = 'vertical',
      actions,
      childProps,
      icon,
      className,
      ...props
    },
    ref,
  ) => {
    return (
      <Alert
        ref={ref}
        {...props}
        icon={false}
        variant={type}
        className={cn(
          'overflow-hidden text-sm leading-normal',
          layout === 'responsive' && '@container',
          className,
        )}
      >
        <div className="flex items-start gap-3">
          {showIcon && (icon ?? <AdmonitionTypeIcon type={type} />)}
          <div
            className={cn(
              'min-w-0 flex-1',
              layout === 'vertical' && 'flex flex-col',
              layout === 'horizontal' && [
                'flex flex-row items-center justify-between',
                'gap-x-6 lg:gap-x-8',
              ],
              layout === 'responsive' && [
                'flex flex-col',
                '@md:flex-row @md:items-center @md:justify-between',
                '@md:gap-x-6 @lg:gap-x-8',
              ],
            )}
          >
            <div
              className={cn(
                showIcon && (title || description || children) && (title ? 'mt-0.75' : 'mt-0.5'),
              )}
            >
              {title && (
                <AlertTitle
                  {...childProps?.title}
                  className={cn('text-foreground', childProps?.title?.className)}
                >
                  {title}
                </AlertTitle>
              )}
              {description && (
                <AlertDescription
                  {...childProps?.description}
                  className={cn(admonitionBodyClassName, childProps?.description?.className)}
                >
                  {description}
                </AlertDescription>
              )}
              {children && (
                <AlertDescription
                  {...childProps?.description}
                  className={cn(admonitionBodyClassName, childProps?.description?.className)}
                >
                  {children}
                </AlertDescription>
              )}
            </div>
            {actions && (
              <div
                className={cn(
                  'flex flex-row gap-2',
                  '[&_button]:text-xs [&_a]:text-xs',
                  layout === 'vertical' && 'mt-3 items-start',
                  layout === 'horizontal' && 'items-center',
                  layout === 'responsive' && 'mt-3 items-start @md:mt-0 @md:items-center',
                )}
              >
                {actions}
              </div>
            )}
          </div>
        </div>
      </Alert>
    )
  },
)
Admonition.displayName = 'Admonition'
