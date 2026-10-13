// Derived from supabase/supabase packages/ui-patterns/src/form/KeyValueFieldArray/KeyValueFieldArray.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { ChevronDown, Plus, X } from '@exponetdb/icons'
import {
  Button,
  type ControlSize,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
  Input,
} from '@exponetdb/ui'
import { Fragment, type ReactNode, useRef } from 'react'
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

export type KeyValueFieldArrayAction<TItem> = {
  key: string
  label: ReactNode
  description?: ReactNode
  createRows: () => TItem | TItem[]
  separatorAbove?: boolean
}

export interface KeyValueFieldArrayProps<
  TFieldValues extends FieldValues,
  TFieldArrayName extends FieldArrayPath<TFieldValues>,
  TItem extends FieldArray<TFieldValues, TFieldArrayName> = FieldArray<
    TFieldValues,
    TFieldArrayName
  >,
> {
  control: Control<TFieldValues>
  name: TFieldArrayName
  keyFieldName: Extract<keyof TItem, string>
  valueFieldName: Extract<keyof TItem, string>
  createEmptyRow: () => TItem
  keyPlaceholder: string
  valuePlaceholder: string
  /** The name of the add button, a verb phrase that names the outcome: "Add header". */
  addLabel: string
  addActions?: KeyValueFieldArrayAction<TItem>[]
  disabled?: boolean
  inputSize?: ControlSize
  /**
   * Accessible name of the key input; the row number is appended ("Header name 2").
   * Defaults to `keyPlaceholder`.
   */
  keyLabel?: string
  /** Accessible name of the value input; the row number is appended. Defaults to `valuePlaceholder`. */
  valueLabel?: string
  /**
   * The name of a remove button; the row number is appended ("Remove header 2") so that every
   * button of the array has its own name. Default: "Remove row".
   */
  removeLabel?: string
  /** Names the list of rows ("Headers") for assistive technology. */
  'aria-label'?: string
  'aria-labelledby'?: string
  className?: string
  rowsClassName?: string
  rowClassName?: string
  keyInputClassName?: string
  valueInputClassName?: string
  addButtonClassName?: string
  removeButtonClassName?: string
}

const toFieldPath = <TFieldValues extends FieldValues>(path: string) => {
  return path as FieldPath<TFieldValues>
}

/**
 * Rendering-only field array for text/text pairs.
 *
 * Consumers own validation in their resolver schema (zod) and can rely on the nested
 * `FormMessage` instances here to display per-cell errors.
 *
 * Keyboard: every row has two labelled inputs and a labelled remove button; the add button
 * (and its presets menu) comes after the rows. After adding, focus moves to the first field of the
 * new row; after removing, to the row that took its place, else the row above, else the add button.
 * The values are what the person typed into inputs, never rendered as markup.
 */
export const KeyValueFieldArray = <
  TFieldValues extends FieldValues,
  TFieldArrayName extends FieldArrayPath<TFieldValues>,
  TItem extends FieldArray<TFieldValues, TFieldArrayName> = FieldArray<
    TFieldValues,
    TFieldArrayName
  >,
>({
  control,
  name,
  keyFieldName,
  valueFieldName,
  createEmptyRow,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
  addActions = [],
  disabled = false,
  inputSize = 'small',
  keyLabel = keyPlaceholder,
  valueLabel = valuePlaceholder,
  removeLabel = 'Remove row',
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  className,
  rowsClassName = 'space-y-3 mt-1',
  rowClassName,
  keyInputClassName,
  valueInputClassName,
  addButtonClassName,
  removeButtonClassName,
}: KeyValueFieldArrayProps<TFieldValues, TFieldArrayName, TItem>) => {
  const { fields, append, remove } = useFieldArray<TFieldValues, TFieldArrayName, 'fieldId'>({
    control,
    name,
    keyName: 'fieldId',
  })
  const focus = useFieldArrayFocus(fields)
  // The menu returns focus to its trigger when it closes; a preset that added rows keeps it in the form.
  const presetAddedRows = useRef(false)

  const typedFields = fields as FieldArrayWithId<TFieldValues, TFieldArrayName, 'fieldId'>[]
  const hasAddActions = addActions.length > 0
  const addActionsLabel = `${addLabel} options`

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
                name={toFieldPath<TFieldValues>(`${name}.${index}.${keyFieldName}`)}
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormControl>
                      <Input
                        {...field}
                        size={inputSize}
                        className={cn('w-full', keyInputClassName)}
                        placeholder={keyPlaceholder}
                        aria-label={`${keyLabel} ${index + 1}`}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={disabled}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={control}
                name={toFieldPath<TFieldValues>(`${name}.${index}.${valueFieldName}`)}
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormControl>
                      <Input
                        {...field}
                        size={inputSize}
                        className={cn('w-full', valueInputClassName)}
                        placeholder={valuePlaceholder}
                        aria-label={`${valueLabel} ${index + 1}`}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={disabled}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <Button
                size={inputSize}
                type="button"
                icon={<X size={12} />}
                aria-label={`${removeLabel} ${index + 1}`}
                disabled={disabled}
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
          size="tiny"
          type="button"
          icon={<Plus />}
          disabled={disabled}
          onClick={() => {
            focus.focusRowAfterUpdate(typedFields.length)
            append(createEmptyRow(), { shouldFocus: false })
          }}
          className={cn(
            hasAddActions &&
              'rounded-r-none px-3 hover:z-10 focus-visible:z-10 focus-visible:rounded-r-sm',
            addButtonClassName,
          )}
        >
          {addLabel}
        </Button>

        {hasAddActions ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="tiny"
                type="button"
                icon={<ChevronDown size={14} />}
                aria-label={addActionsLabel}
                disabled={disabled}
                className="shrink-0 rounded-l-none px-[4px] py-[5px] -ml-px focus-visible:z-10 focus-visible:rounded-l-sm"
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              side="bottom"
              onCloseAutoFocus={(event) => {
                if (presetAddedRows.current) {
                  event.preventDefault()
                  presetAddedRows.current = false
                }
              }}
            >
              {addActions.map((action) => (
                <Fragment key={action.key}>
                  {action.separatorAbove ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuItem
                    onSelect={() => {
                      presetAddedRows.current = true
                      focus.focusRowAfterUpdate(typedFields.length)
                      append(action.createRows(), { shouldFocus: false })
                    }}
                  >
                    {action.description ? (
                      <div className="space-y-1">
                        <div className="block text-foreground">{action.label}</div>
                        <div className="text-foreground-light">{action.description}</div>
                      </div>
                    ) : (
                      action.label
                    )}
                  </DropdownMenuItem>
                </Fragment>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  )
}
