// Derived from supabase/supabase packages/ui/src/components/Button/Button.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { Loader2 } from '@exponetdb/icons'
import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import {
  type ButtonHTMLAttributes,
  cloneElement,
  forwardRef,
  isValidElement,
  type KeyboardEvent,
  type MouseEvent,
  type MouseEventHandler,
  type ReactNode,
} from 'react'

import { SIZE_VARIANTS } from './lib/constants.ts'
import { getExplicitTabIndex } from './lib/get-explicit-tab-index.ts'
import { controlRadiusBySize } from './lib/raised-control-surface.ts'
import { cn } from './lib/utils.ts'

const gradientOverlay =
  'bg-[linear-gradient(to_bottom,hsl(var(--colors-white)/0.015),hsl(var(--colors-black)/0.01))]'

const buttonVariants = cva(
  `relative
  inline-flex items-center justify-center
  cursor-pointer
  space-x-2
  text-center
  font-medium
  ease-[cubic-bezier(0.22,1,0.36,1)]
  duration-200
  rounded-md
  transition-[background-color,border-color,color,scale]
  [&:not([aria-haspopup])]:motion-safe:active:scale-[0.97]
  focus-ring
  border
  control-surface-shadows
  `,
  {
    variants: {
      variant: {
        primary: `
          border-0
          bg-primary-solid
          ${gradientOverlay}
          text-primary-solid-foreground
          shadow-[var(--button-shadow-raised)]
          hover:bg-[var(--primary-solid-hover)]
          data-[state=open]:bg-[var(--primary-solid-hover)]
          `,
        default: 'border-0 raised-control-surface',
        secondary: `
          bg-foreground
          text-background
          border-0
          shadow-[var(--button-shadow-drop)]
          hover:bg-foreground/90
          data-[state=open]:bg-foreground/90
        `,
        outline: `
          text-foreground
          bg-transparent
          border-strong hover:border-foreground-muted
          data-[state=open]:border-stronger
        `,
        dashed: `
          text-foreground
          border
          border-dashed
          border-strong hover:border-control-hover
          bg-transparent
          data-[state=open]:border-control-hover
        `,
        link: `
          text-primary
          border
          border-transparent
          hover:bg-primary-bright/15
          shadow-none
          data-[state=open]:bg-primary-bright/15
        `,
        text: `
          text-foreground
          hover:bg-accent
          shadow-none
          data-[state=open]:bg-accent
          border-transparent
        `,
        danger: `
          border-0
          bg-destructive
          ${gradientOverlay}
          text-destructive-foreground
          shadow-[var(--button-shadow-raised)]
          hover:bg-[var(--destructive-hover)]
          data-[state=open]:bg-[var(--destructive-hover)]
        `,
        warning: `
          border-0
          bg-warning
          ${gradientOverlay}
          text-warning-foreground
          shadow-[var(--button-shadow-raised)]
          hover:bg-[var(--warning-hover)]
          data-[state=open]:bg-[var(--warning-hover)]
        `,
      },
      block: {
        true: 'w-full flex items-center justify-center',
      },
      size: {
        tiny: `${SIZE_VARIANTS.tiny} ${controlRadiusBySize.tiny}`,
        small: `${SIZE_VARIANTS.small} ${controlRadiusBySize.small}`,
        medium: `${SIZE_VARIANTS.medium} ${controlRadiusBySize.medium}`,
        large: `${SIZE_VARIANTS.large} ${controlRadiusBySize.large}`,
      },
      // A disabled control that is not focusable: native `disabled`, no pointer events.
      disabled: {
        true: 'opacity-50 cursor-not-allowed pointer-events-none',
      },
      // A disabled control that stays focusable and hoverable so a tooltip can explain
      // it: `aria-disabled` instead of `disabled`, and no press feedback.
      focusableWhenDisabled: {
        true: 'opacity-50 cursor-not-allowed [&:not([aria-haspopup])]:motion-safe:active:scale-100',
      },
      rounded: {
        true: 'rounded-full',
      },
      // Icon-only buttons are square at the height of their size.
      iconOnly: {
        true: 'hit-area-1 px-0',
      },
    },
    compoundVariants: [
      { iconOnly: true, size: 'tiny', class: 'w-[26px]' },
      { iconOnly: true, size: 'small', class: 'w-[34px]' },
      { iconOnly: true, size: 'medium', class: 'w-[38px]' },
      { iconOnly: true, size: 'large', class: 'w-[42px]' },
    ],
    // Match <Button size="tiny"> so raw buttonVariants({ variant }) keeps sizing.
    // Fixed icon shells that omit size must override padding (e.g. px-0 with h/w-[30px]).
    defaultVariants: {
      size: 'tiny',
    },
  },
)

const iconContainerVariants = cva('inline-flex items-center justify-center shrink-0', {
  variants: {
    size: {
      tiny: '[&_svg]:h-[14px] [&_svg]:w-[14px]',
      small: '[&_svg]:h-[18px] [&_svg]:w-[18px]',
      medium: '[&_svg]:h-[20px] [&_svg]:w-[20px]',
      large: '[&_svg]:h-[20px] [&_svg]:w-[20px]',
    },
    variant: {
      primary: 'text-primary-solid-foreground/50',
      default: 'text-foreground-lighter',
      secondary: 'text-background',
      outline: 'text-foreground-lighter',
      dashed: 'text-foreground-lighter',
      link: 'text-primary',
      text: 'text-foreground-lighter',
      danger: 'text-destructive-foreground/50',
      warning: 'text-warning-foreground/50',
    },
  },
})

const spinnerVariants = cva('animate-spin motion-reduce:animate-none', {
  variants: {
    variant: {
      primary: 'text-primary-solid-foreground/50',
      default: 'text-foreground-lighter',
      secondary: 'text-background',
      outline: 'text-foreground-lighter',
      dashed: 'text-foreground-lighter',
      link: 'text-primary',
      text: 'text-foreground-muted',
      danger: 'text-destructive-foreground/50',
      warning: 'text-warning-foreground/50',
    },
  },
})

export type ButtonVariantProps = VariantProps<typeof buttonVariants>
export type ButtonVariant = NonNullable<ButtonVariantProps['variant']>
export type ButtonSize = NonNullable<ButtonVariantProps['size']>

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** @default 'default' */
  variant?: ButtonVariant
  /** @default 'tiny' */
  size?: ButtonSize
  /** Fills the width of the container. */
  block?: boolean
  /** Pill shape. */
  rounded?: boolean
  /** Renders the single child element (a link, say) with the button's look and behavior. */
  asChild?: boolean
  /** Shows a spinner, sets `aria-busy` and disables the button. */
  loading?: boolean
  /** Icon before the label. */
  icon?: ReactNode
  /** Icon after the label. */
  iconRight?: ReactNode
  /**
   * Keeps a disabled button keyboard-focusable by using `aria-disabled`
   * instead of native `disabled`, and swallows clicks and Enter or Space
   * activation. Use it when the control needs a tooltip that explains why it
   * is unavailable.
   */
  focusableWhenDisabled?: boolean
}

type SlottedChildProps = {
  children?: ReactNode
  onClick?: MouseEventHandler<HTMLElement>
}

const hasContent = (node: ReactNode): boolean =>
  node !== null && node !== undefined && typeof node !== 'boolean' && node !== ''

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      asChild = false,
      size = 'tiny',
      variant = 'default',
      children,
      loading = false,
      block,
      icon,
      iconRight,
      type,
      rounded,
      focusableWhenDisabled: focusableWhenDisabledProp = false,
      className,
      tabIndex,
      disabled: disabledProp,
      onClick,
      onKeyDown,
      ...rest
    },
    ref,
  ) => {
    const Comp = asChild ? Slot.Slot : 'button'
    // A loading button is disabled.
    const disabled = loading || disabledProp === true
    const focusableWhenDisabled = disabled && focusableWhenDisabledProp
    // Disabled and out of the tab order. A slotted child (a link, say) cannot use `disabled`.
    const inert = disabled && !focusableWhenDisabled
    const useNativeDisabled = inert && !asChild

    const renderIcon = (content: ReactNode) => (
      <span aria-hidden className={iconContainerVariants({ size, variant })}>
        {content}
      </span>
    )

    const renderContent = (label: ReactNode) => (
      <>
        {loading
          ? renderIcon(<Loader2 className={spinnerVariants({ variant })} />)
          : hasContent(icon)
            ? renderIcon(icon)
            : null}
        {hasContent(label) ? <span className="truncate">{label}</span> : null}
        {!loading && hasContent(iconRight) ? renderIcon(iconRight) : null}
      </>
    )

    const handleActivation = (
      event: MouseEvent<HTMLElement>,
      childOnClick?: MouseEventHandler<HTMLElement>,
    ) => {
      if (disabled) {
        event.preventDefault()
        event.stopPropagation()
        return
      }

      childOnClick?.(event)
      if (!event.defaultPrevented) {
        onClick?.(event as MouseEvent<HTMLButtonElement>)
      }
    }

    const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
      if (focusableWhenDisabled && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault()
        return
      }
      onKeyDown?.(event)
    }

    let content: ReactNode = null
    if (asChild) {
      if (isValidElement<SlottedChildProps>(children)) {
        content = cloneElement(
          children,
          { onClick: (event) => handleActivation(event, children.props.onClick) },
          renderContent(children.props.children),
        )
      }
    } else {
      content = renderContent(children)
    }

    return (
      <Comp
        ref={ref}
        data-size={size}
        // A slotted child keeps its own type (an anchor has none).
        type={asChild ? type : (type ?? 'button')}
        {...rest}
        aria-busy={loading || undefined}
        aria-disabled={focusableWhenDisabled || (disabled && asChild) || undefined}
        disabled={useNativeDisabled || undefined}
        tabIndex={getExplicitTabIndex(tabIndex, inert)}
        className={cn(
          buttonVariants({
            variant,
            size,
            disabled: inert,
            focusableWhenDisabled,
            block,
            rounded,
            iconOnly: !hasContent(children),
          }),
          className,
        )}
        onClick={
          asChild ? undefined : (event: MouseEvent<HTMLButtonElement>) => handleActivation(event)
        }
        onKeyDown={handleKeyDown}
      >
        {content}
      </Comp>
    )
  },
)

Button.displayName = 'Button'

export { Button, buttonVariants }
