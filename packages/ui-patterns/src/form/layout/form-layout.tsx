// Derived from supabase/supabase packages/ui-patterns/src/form/Layout/FormLayout.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.

import {
  type ControlSize,
  cn,
  FormDescription,
  FormLabel,
  FormMessage,
  Label,
  SIZE,
} from '@exponetdb/ui'
import { cva } from 'class-variance-authority'
import { type ComponentPropsWithoutRef, forwardRef, type ReactNode, useId } from 'react'

/**
 * The props a control needs to be part of a `FormLayout`: the id its label points at, the ids of
 * its description and error, and its validity. `FormLayout` passes them to a render function child
 * (`{(control) => <Input {...control} />}`); inside a react-hook-form field `FormControl` does the
 * same job and `FormItemLayout` is the component to use.
 */
export interface FormLayoutControlProps {
  id: string
  'aria-describedby': string | undefined
  'aria-invalid': true | undefined
}

export type FormLayoutKind = 'horizontal' | 'vertical' | 'flex' | 'flex-row-reverse'

type Props = {
  align?: 'left' | 'right'
  /** Help text below the control (hints, units, what happens). Linked to the control with `aria-describedby`. */
  description?: ReactNode
  /**
   * The error text of a form without react-hook-form. It is announced (`role="alert"`) and linked
   * to the control only while it is set. Inside `FormItemLayout` the error comes from the form state.
   */
  error?: ReactNode
  label?: ReactNode
  labelOptional?: ReactNode
  layout?: FormLayoutKind
  size?: ControlSize
  beforeLabel?: ReactNode
  /** Something that belongs to the label, such as an info tooltip trigger. */
  afterLabel?: ReactNode
  nonBoxInput?: boolean
  /** Set by `FormItemLayout`: label, description and message come from the react-hook-form field. */
  isReactForm?: boolean
  hideMessage?: boolean
  /** The id of the control, which the label points at. Generated when omitted. */
  id?: string
  /**
   * For layout="horizontal", switches the label/content split to react to the nearest
   * `@container` ancestor's width instead of the viewport width. Use when the layout sits
   * inside a narrower column (e.g. next to a sidebar) so it stacks to a single column as
   * soon as that column gets tight, rather than waiting for a viewport breakpoint that may
   * never reflect the column's actual available space.
   */
  isContainerResponsive?: boolean
  /** The control, or a function that receives the ids and the validity to put on it. */
  children?: ReactNode | ((control: FormLayoutControlProps) => ReactNode)
}

export type FormLayoutProps = Omit<ComponentPropsWithoutRef<'div'>, keyof Props> & Props

const containerVariants = cva('relative', {
  variants: {
    size: {
      tiny: SIZE.text.tiny,
      small: SIZE.text.small,
      medium: SIZE.text.medium,
      large: SIZE.text.large,
    },
    layout: {
      horizontal: 'flex flex-col gap-2',
      vertical: 'flex flex-col gap-2',
      flex: 'flex flex-row gap-3',
      'flex-row-reverse':
        'flex flex-col-reverse gap-2 md:gap-6 md:flex-row-reverse md:justify-between',
    },
    align: { left: '', right: '' },
    responsive: { true: '', false: '' },
  },
  compoundVariants: [
    { layout: 'flex', align: 'right', className: 'justify-between' },
    { layout: 'flex-row-reverse', align: 'right', className: 'justify-between' },
    { layout: 'horizontal', responsive: false, className: 'md:grid md:grid-cols-12' },
    { layout: 'horizontal', responsive: true, className: '@xl:grid @xl:grid-cols-12' },
  ],
  defaultVariants: { responsive: false },
})

const descriptionVariants = cva('text-foreground-lighter leading-normal', {
  variants: {
    size: {
      tiny: SIZE.text.tiny,
      small: SIZE.text.small,
      medium: SIZE.text.medium,
      large: SIZE.text.large,
    },
    layout: {
      vertical: 'mt-2',
      horizontal: 'mt-2',
      flex: '',
      'flex-row-reverse': '',
    },
  },
})

const labelAdjunctVariants = cva('text-foreground-muted', {
  variants: {
    size: {
      tiny: SIZE.text.tiny,
      small: SIZE.text.small,
      medium: SIZE.text.medium,
      large: SIZE.text.large,
    },
  },
})

function labelContainerClass(layout: FormLayoutKind, align: 'left' | 'right'): string {
  const flex = layout === 'flex' || layout === 'flex-row-reverse'
  return cn(
    layout === 'horizontal' && 'flex flex-col gap-2 col-span-4',
    layout === 'vertical' && 'flex flex-row gap-2 justify-between',
    layout === 'flex' && 'flex flex-col gap-0 min-w-0',
    layout === 'flex-row-reverse' && 'flex flex-col min-w-0 grow',
    flex && (align === 'left' ? 'order-2' : 'order-1'),
  )
}

function dataContainerClass(layout: FormLayoutKind, align: 'left' | 'right'): string {
  return cn(
    align === 'left' ? 'order-1' : 'order-2',
    layout === 'vertical' && 'col-span-12',
    layout === 'horizontal' && align === 'left' && 'col-span-8',
    layout === 'horizontal' && align === 'right' && 'text-right',
  )
}

function flexContainerClass(layout: FormLayoutKind, align: 'left' | 'right'): string {
  return cn(
    align === 'right' && 'order-last',
    layout === 'flex-row-reverse' &&
      'flex flex-col justify-center items-start md:items-end shrink-0 md:w-1/2 xl:w-2/5 [&>div]:md:w-full',
  )
}

function nonBoxInputClass(nonBoxInput: boolean, hasLabel: boolean, layout: FormLayoutKind): string {
  if (!(nonBoxInput && hasLabel)) return ''
  if (layout === 'vertical') return 'my-3'
  if (layout === 'horizontal') return 'my-3 md:mt-0 mb-3'
  return ''
}

/**
 * Label, control, description and error of one form field, in the four layouts of the design system
 * (`vertical`, `horizontal`, and the `flex` and `flex-row-reverse` rows for switches and checkboxes).
 *
 * Accessibility contract:
 * - the label points at the control (`htmlFor`);
 * - the description and the error are linked to the control with `aria-describedby`;
 * - the error is a `role="alert"` paragraph that exists only while there is an error, and the
 *   control is `aria-invalid` only then.
 *
 * Without react-hook-form, pass `error` and give the control the props the render function
 * receives. Inside a react-hook-form field use `FormItemLayout`, which sets `isReactForm`.
 */
export const FormLayout = forwardRef<HTMLDivElement, FormLayoutProps>(
  (
    {
      align = 'left',
      className,
      description,
      id,
      label,
      labelOptional,
      layout = 'vertical',
      style,
      size = 'medium',
      beforeLabel,
      afterLabel,
      nonBoxInput = !label,
      hideMessage = false,
      isReactForm = false,
      error,
      isContainerResponsive = false,
      children,
      ...props
    },
    ref,
  ) => {
    const generatedId = useId()
    const controlId = id ?? generatedId
    const descriptionId = `${controlId}-description`
    const messageId = `${controlId}-error`
    const flex = layout === 'flex' || layout === 'flex-row-reverse'
    const hasLabel = Boolean(label || beforeLabel || afterLabel)
    // Standalone forms: the control is invalid while there is an error, even when the message is
    // shown elsewhere (`hideMessage`); the message is linked only when this layout renders it.
    const invalid = !isReactForm && Boolean(error)
    const showError = invalid && !hideMessage

    const describedBy =
      [description ? descriptionId : undefined, showError ? messageId : undefined]
        .filter((part): part is string => part !== undefined)
        .join(' ') || undefined

    const controlProps: FormLayoutControlProps = {
      id: controlId,
      'aria-describedby': describedBy,
      'aria-invalid': invalid ? true : undefined,
    }
    const control = typeof children === 'function' ? children(controlProps) : children

    const renderError = isReactForm ? (
      hideMessage ? null : (
        <FormMessage
          className={cn('mt-2', layout === 'flex-row-reverse' && 'mt-0')}
          data-formlayout-id="message"
        />
      )
    ) : showError ? (
      // UntrustedText: an error can carry a server message; it renders as text.
      <p
        id={messageId}
        role="alert"
        className={cn('mt-2 text-sm text-destructive', layout === 'flex-row-reverse' && 'mt-0')}
        data-formlayout-id="message"
      >
        {error}
      </p>
    ) : null

    const renderDescription = description ? (
      isReactForm ? (
        <FormDescription
          className={cn(descriptionVariants({ size, layout }))}
          data-formlayout-id="description"
        >
          {description}
        </FormDescription>
      ) : (
        // A div rather than a p: descriptions are arbitrary JSX that may contain block elements.
        <div
          id={descriptionId}
          className={cn(descriptionVariants({ size, layout }))}
          data-formlayout-id="description"
        >
          {description}
        </div>
      )
    ) : null

    const labelContents = (
      <>
        {beforeLabel ? (
          <span
            className={cn(labelAdjunctVariants({ size }))}
            id={`${controlId}-before`}
            data-formlayout-id="beforeLabel"
          >
            {beforeLabel}
          </span>
        ) : null}
        <span>{label}</span>
        {afterLabel ? (
          <span
            className={cn(labelAdjunctVariants({ size }))}
            id={`${controlId}-after`}
            data-formlayout-id="afterLabel"
          >
            {afterLabel}
          </span>
        ) : null}
      </>
    )

    return (
      <div
        ref={ref}
        {...props}
        className={cn(
          containerVariants({ size, align, layout, responsive: isContainerResponsive }),
          className,
        )}
      >
        {flex ? (
          <div className={flexContainerClass(layout, align)}>
            {control}
            {layout === 'flex-row-reverse' ? renderError : null}
          </div>
        ) : null}
        {hasLabel || labelOptional || layout === 'horizontal' ? (
          <div className={labelContainerClass(layout, align)} data-formlayout-id="labelContainer">
            {hasLabel && isReactForm ? (
              <FormLabel
                className="text-foreground flex gap-2 items-center wrap-break-word"
                data-formlayout-id="formLabel"
              >
                {labelContents}
              </FormLabel>
            ) : hasLabel ? (
              <Label
                className="text-foreground flex gap-2 items-center wrap-break-word leading-normal"
                data-formlayout-id="label"
                htmlFor={controlId}
              >
                {labelContents}
              </Label>
            ) : null}
            {labelOptional ? (
              <span
                className={cn(labelAdjunctVariants({ size }))}
                id={`${controlId}-optional`}
                data-formlayout-id="labelOptional"
              >
                {labelOptional}
              </span>
            ) : null}
            {flex ? (
              <>
                {renderDescription}
                {layout !== 'flex-row-reverse' ? renderError : null}
              </>
            ) : null}
          </div>
        ) : null}
        {!flex ? (
          <div
            className={dataContainerClass(layout, align)}
            style={style}
            data-formlayout-id="dataContainer"
          >
            <div
              className={nonBoxInputClass(nonBoxInput, Boolean(label), layout) || undefined}
              data-formlayout-id="nonBoxInputContainer"
            >
              {control}
            </div>
            {renderError}
            {renderDescription}
          </div>
        ) : null}
      </div>
    )
  },
)
FormLayout.displayName = 'FormLayout'
