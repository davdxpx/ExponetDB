import { cn, inputVariants, Label } from '@exponetdb/ui'
import { forwardRef, type ReactNode, type SelectHTMLAttributes } from 'react'
import type { Me } from '../../lib/session/guard.tsx'

/**
 * Small form parts of the administration pages (access, audit, settings):
 * a native `<select>` styled like the inputs (keyboard and screen reader
 * behavior of the platform, no portal), a labeled field, and the check
 * whether the session holds a permission at all. That check only decides
 * what the page offers; the server decides every request again (C-9).
 */
export interface NativeSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  readonly options: readonly { readonly value: string; readonly label: string }[]
}

export const NativeSelect = forwardRef<HTMLSelectElement, NativeSelectProps>(function NativeSelect(
  { options, className, ...props },
  ref,
) {
  return (
    <select ref={ref} {...props} className={cn(inputVariants({ size: 'small' }), className)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
})

export function Field({
  id,
  label,
  description,
  error,
  children,
}: {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly error?: string | undefined
  readonly children: ReactNode
}): ReactNode {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {description === undefined ? null : (
        <p id={`${id}-description`} className="text-xs text-foreground-lighter">
          {description}
        </p>
      )}
      {error === undefined || error === '' ? null : (
        <p id={`${id}-error`} className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

export type Permission = Me['effectivePermissions'][number]['permission']

/** Whether the session holds `permission` at any scope (what the page offers; the server decides). */
export function holds(me: Me, permission: Permission): boolean {
  return me.effectivePermissions.some((entry) => entry.permission === permission)
}
