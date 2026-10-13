// Derived from supabase/supabase packages/ui/src/components/shadcn/ui/form.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { type Label as LabelPrimitive, Slot as SlotPrimitive } from 'radix-ui'
import * as React from 'react'
import {
  Controller,
  type ControllerProps,
  type FieldPath,
  type FieldValues,
  FormProvider,
  useFormContext,
  useWatch,
} from 'react-hook-form'
import type { InputProps } from './input.tsx'
import { InputGroupInput, InputGroupTextarea } from './input-group.tsx'
import { Label } from './label.tsx'
import { cn } from './lib/utils.ts'
import type { TextareaProps } from './textarea.tsx'

const Form = FormProvider

type FormFieldContextValue = {
  name: string
}

const FormFieldContext = React.createContext<FormFieldContextValue | null>(null)

const FormField = <
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>({
  ...props
}: ControllerProps<TFieldValues, TName>) => {
  const value = React.useMemo(() => ({ name: props.name }), [props.name])

  return (
    <FormFieldContext.Provider value={value}>
      <Controller {...props} />
    </FormFieldContext.Provider>
  )
}

type FormItemContextValue = {
  id: string
}

const FormItemContext = React.createContext<FormItemContextValue | null>(null)

const useFormField = () => {
  const fieldContext = React.useContext(FormFieldContext)
  const itemContext = React.useContext(FormItemContext)
  const { getFieldState, formState } = useFormContext()

  if (!fieldContext) {
    throw new Error('useFormField should be used within <FormField>')
  }
  if (!itemContext) {
    throw new Error('useFormField should be used within <FormItem>')
  }

  const fieldState = getFieldState(fieldContext.name, formState)
  const { id } = itemContext

  return {
    id,
    name: fieldContext.name,
    formItemId: `${id}-form-item`,
    formDescriptionId: `${id}-form-item-description`,
    formMessageId: `${id}-form-item-message`,
    ...fieldState,
  }
}

const FormItem = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { asChild?: boolean }
>(({ asChild, ...props }, ref) => {
  const id = React.useId()
  const value = React.useMemo(() => ({ id }), [id])

  const Comp = asChild ? SlotPrimitive.Slot : 'div'

  return (
    <FormItemContext.Provider value={value}>
      <Comp ref={ref} {...props} />
    </FormItemContext.Provider>
  )
})
FormItem.displayName = 'FormItem'

const FormLabel = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> & { enableSelection?: boolean }
>(({ className, enableSelection = false, htmlFor, ...props }, ref) => {
  const { error, formItemId } = useFormField()

  const Comp = enableSelection ? 'label' : Label

  return (
    <Comp
      ref={ref}
      className={cn(
        'text-foreground-light text-sm',
        'transition-colors',
        error && 'text-destructive!',
        className,
        'leading-normal',
      )}
      htmlFor={htmlFor ?? formItemId}
      {...props}
    />
  )
})
FormLabel.displayName = 'FormLabel'

const FormControl = React.forwardRef<
  React.ElementRef<typeof SlotPrimitive.Slot>,
  React.ComponentPropsWithoutRef<typeof SlotPrimitive.Slot>
>(({ ...props }, ref) => {
  const { error, formItemId, formDescriptionId, formMessageId } = useFormField()

  return (
    <SlotPrimitive.Slot
      ref={ref}
      id={formItemId}
      aria-describedby={!error ? `${formDescriptionId}` : `${formDescriptionId} ${formMessageId}`}
      aria-invalid={!!error}
      {...props}
    />
  )
})
FormControl.displayName = 'FormControl'

const FormDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const { formDescriptionId } = useFormField()

    return (
      <div
        ref={ref}
        id={formDescriptionId}
        className={cn('text-sm text-foreground-light', className)}
        {...props}
      />
    )
  },
)
FormDescription.displayName = 'FormDescription'

/**
 * The validation message of the field, or the children when the field is valid
 * (a hint, say). Text only: the message is rendered as a React text node.
 * A validation message is announced when it appears (`role="alert"`).
 */
const FormMessage = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, children, ...props }, ref) => {
  const { error, formMessageId } = useFormField()
  const body = error ? (error.message ? String(error.message) : null) : children

  if (!body) return null

  return (
    <p
      ref={ref}
      id={formMessageId}
      role={error ? 'alert' : undefined}
      className={cn('text-sm text-destructive', className)}
      {...props}
    >
      {body}
    </p>
  )
})
FormMessage.displayName = 'FormMessage'

const FormInputGroupInput = React.forwardRef<HTMLInputElement, InputProps>((props, ref) => {
  const { error, formItemId, formDescriptionId, formMessageId } = useFormField()

  return (
    <InputGroupInput
      ref={ref}
      id={formItemId}
      aria-describedby={!error ? formDescriptionId : `${formDescriptionId} ${formMessageId}`}
      aria-invalid={!!error}
      {...props}
    />
  )
})
FormInputGroupInput.displayName = 'FormInputGroupInput'

const FormInputGroupTextArea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  (props, ref) => {
    const { error, formItemId, formDescriptionId, formMessageId } = useFormField()

    return (
      <InputGroupTextarea
        ref={ref}
        id={formItemId}
        aria-describedby={!error ? formDescriptionId : `${formDescriptionId} ${formMessageId}`}
        aria-invalid={!!error}
        {...props}
      />
    )
  },
)
FormInputGroupTextArea.displayName = 'FormInputGroupTextArea'

export {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormInputGroupInput,
  FormInputGroupTextArea,
  FormItem,
  FormLabel,
  FormMessage,
  useFormField,
  useWatch,
}
