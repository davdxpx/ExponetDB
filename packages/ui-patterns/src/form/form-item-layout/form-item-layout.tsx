// Derived from supabase/supabase packages/ui-patterns/src/form/FormItemLayout/FormItemLayout.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.

import { FormItem } from '@exponetdb/ui'
import { forwardRef, type ReactNode } from 'react'

import { FormLayout, type FormLayoutProps } from '../layout/form-layout.tsx'

export type FormItemLayoutProps = Omit<
  FormLayoutProps,
  'isReactForm' | 'error' | 'id' | 'children'
> & {
  /** The control, wrapped in `FormControl` so that it gets the id and the `aria-*` of the field. */
  children?: ReactNode
}

/**
 * The layout of one field of a react-hook-form form: put it inside a `FormField` render function
 * and wrap the control in `FormControl`.
 *
 * ```tsx
 * <FormField control={form.control} name="name" render={({ field }) => (
 *   <FormItemLayout label="Target name" description="Lowercase letters and dashes.">
 *     <FormControl><Input {...field} /></FormControl>
 *   </FormItemLayout>
 * )} />
 * ```
 *
 * The label points at the control, the description and the error are linked to it, and the error
 * is a `role="alert"` message that exists only while the field has an error (see `FormLayout`).
 */
export const FormItemLayout = forwardRef<HTMLDivElement, FormItemLayoutProps>(
  ({ children, ...props }, ref) => (
    <FormItem>
      <FormLayout {...props} ref={ref} isReactForm>
        {children}
      </FormLayout>
    </FormItem>
  ),
)
FormItemLayout.displayName = 'FormItemLayout'
