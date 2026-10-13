// Derived from supabase/supabase packages/ui-patterns/src/form/SingleValueFieldArray/SingleValueFieldArray.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { Plus, X } from '@exponetdb/icons'
import {
  Button,
  type ControlSize,
  cn,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
  Input,
} from '@exponetdb/ui'
import type { ClipboardEvent } from 'react'
import {
  type Control,
  type FieldArray,
  type FieldArrayPath,
  type FieldArrayWithId,
  type FieldPath,
  type FieldValues,
  useFieldArray,
} from 'react-hook-form'

import { useFieldArrayFocus } from '../field-array-focus.ts'

export interface SingleValueFieldArrayProps<
  TFieldValues extends FieldValues,
  TFieldArrayName extends FieldArrayPath<TFieldValues>,
  TItem extends FieldArray<TFieldValues, TFieldArrayName> = FieldArray<
    TFieldValues,
    TFieldArrayName
  >,
> {
  control: Control<TFieldValues>
  name: TFieldArrayName
  valueFieldName: Extract<keyof TItem, string>
  createEmptyRow: () => TItem
  placeholder: string
  /** The name of the add button, a verb phrase that names the outcome: "Add redirect URL". */
  addLabel: string
  /**
   * The name of a remove button; the row number is appended ("Remove redirect URL 2") so that every
   * button of the array has its own name. Default: "Remove row".
   */
  removeLabel?: string
  /** Accessible name of the value input; the row number is appended. Defaults to `placeholder`. */
  valueLabel?: string
  /** Names the list of rows ("Redirect URLs") for assistive technology. */
  'aria-label'?: string
  'aria-labelledby'?: string
  disabled?: boolean
  /** When set, pasting text that this splits into several values creates one row per value. */
  pasteSeparator?: RegExp
  minimumRows?: number
  inputSize?: ControlSize
  inputAutoComplete?: string
  className?: string
  rowsClassName?: string
  rowClassName?: string
  inputClassName?: string
  addButtonClassName?: string
  addButtonType?: React.ComponentProps<typeof Button>['variant']
  addButtonSize?: React.ComponentProps<typeof Button>['size']
  removeButtonClassName?: string
  removeButtonType?: React.ComponentProps<typeof Button>['variant']
  removeButtonSize?: React.ComponentProps<typeof Button>['size']
}

const toFieldPath = <TFieldValues extends FieldValues>(path: string) => {
  return path as FieldPath<TFieldValues>
}

/**
 * Rendering-only field array for single text values (a list of URLs, domains, roles).
 *
 * Consumers own validation in their resolver schema (zod); the nested `FormMessage` shows the
 * per-row error. Every row has a labelled input and a labelled remove button; after adding, focus
 * moves to the new row's field; after removing, to the row that took its place, else the row
 * above, else the add button. With `minimumRows` the last rows cannot be removed.
 */
export const SingleValueFieldArray = <
  TFieldValues extends FieldValues,
  TFieldArrayName extends FieldArrayPath<TFieldValues>,
  TItem extends FieldArray<TFieldValues, TFieldArrayName> = FieldArray<
    TFieldValues,
    TFieldArrayName
  >,
>({
  control,
  name,
  valueFieldName,
  createEmptyRow,
  placeholder,
  addLabel,
  removeLabel = 'Remove row',
  valueLabel = placeholder,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  disabled = false,
  pasteSeparator,
  minimumRows = 0,
  inputSize = 'small',
  inputAutoComplete,
  className,
  rowsClassName = 'space-y-3 mt-1',
  rowClassName,
  inputClassName,
  addButtonClassName,
  addButtonType = 'default',
  addButtonSize,
  removeButtonClassName,
  removeButtonType = 'default',
  removeButtonSize = inputSize,
}: SingleValueFieldArrayProps<TFieldValues, TFieldArrayName, TItem>) => {
  const { fields, append, insert, remove } = useFieldArray<
    TFieldValues,
    TFieldArrayName,
    'fieldId'
  >({
    control,
    name,
    keyName: 'fieldId',
  })
  const focus = useFieldArrayFocus(fields)

  const typedFields = fields as FieldArrayWithId<TFieldValues, TFieldArrayName, 'fieldId'>[]
  const disableRemove = disabled || typedFields.length <= minimumRows

  const createRow = (value: string) =>
    ({ ...(createEmptyRow() as object), [valueFieldName]: value }) as TItem

  const handlePaste = (
    event: ClipboardEvent<HTMLInputElement>,
    index: number,
    onChange: (value: string) => void,
  ) => {
    if (!pasteSeparator) return

    const [first, ...rest] = event.clipboardData
      .getData('text')
      .split(pasteSeparator)
      .map((value) => value.trim())
      .filter(Boolean)
    if (first === undefined || rest.length === 0) return

    event.preventDefault()
    onChange(first)
    insert(index + 1, rest.map(createRow), { shouldFocus: false })
  }

  return (
    <div className={cn('space-y-3', className)}>
      {typedFields.length > 0 ? (
        <ul
          ref={focus.rowsRef}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          className={rowsClassName}
        >
          {typedFields.map((field, index) => (
            <li key={field.fieldId} className={cn('flex items-start gap-2', rowClassName)}>
              <FormField
                control={control}
                name={toFieldPath<TFieldValues>(`${name}.${index}.${valueFieldName}`)}
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormControl>
                      <Input
                        {...field}
                        size={inputSize}
                        autoComplete={inputAutoComplete}
                        className={cn('w-full', inputClassName)}
                        placeholder={placeholder}
                        aria-label={`${valueLabel} ${index + 1}`}
                        disabled={disabled}
                        onPaste={(event) => handlePaste(event, index, field.onChange)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <Button
                variant={removeButtonType}
                size={removeButtonSize}
                type="button"
                icon={<X size={12} />}
                aria-label={`${removeLabel} ${index + 1}`}
                disabled={disableRemove}
                onClick={() => {
                  focus.focusAfterRemove(index, typedFields.length)
                  remove(index)
                }}
                className={cn('shrink-0', removeButtonClassName)}
              />
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex items-center">
        <Button
          ref={focus.addRef}
          variant={addButtonType}
          size={addButtonSize}
          type="button"
          icon={<Plus strokeWidth={1.5} />}
          disabled={disabled}
          onClick={() => {
            focus.focusRowAfterUpdate(typedFields.length)
            append(createEmptyRow(), { shouldFocus: false })
          }}
          className={addButtonClassName}
        >
          {addLabel}
        </Button>
      </div>
    </div>
  )
}
