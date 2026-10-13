// Derived from supabase/supabase packages/ui-patterns/src/form/utils.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.

import { FormControl, FormItem } from '@exponetdb/ui'
import { type ComponentPropsWithoutRef, type ElementRef, forwardRef } from 'react'
import type { ControllerRenderProps, FieldPath, FieldValues } from 'react-hook-form'

/**
 * Handles react-hook-form field type for FormItem<name> components
 */
export interface FormItemProps<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
> {
  field?: ControllerRenderProps<TFieldValues, TName>
}

/**
 * Repeatable wrapper for FormItem<name> components
 */
export const FormItemWrapper = forwardRef<
  ElementRef<typeof FormItem>,
  ComponentPropsWithoutRef<typeof FormItem>
>(({ children, ...props }, ref) => (
  <FormItem ref={ref} {...props}>
    <FormControl>{children}</FormControl>
  </FormItem>
))
FormItemWrapper.displayName = 'FormItemWrapper'
