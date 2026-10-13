import { type RefObject, useCallback, useEffect, useRef } from 'react'

type PendingFocus = { readonly kind: 'row'; readonly index: number } | { readonly kind: 'add' }

export interface FieldArrayFocus {
  /** Put on the `<ul>` of the rows: its `<li>` children are the rows. */
  readonly rowsRef: RefObject<HTMLUListElement | null>
  /** Put on the add button. */
  readonly addRef: RefObject<HTMLButtonElement | null>
  /** After the next update of the fields, focus the first field of row `index`. */
  readonly focusRowAfterUpdate: (index: number) => void
  /**
   * Call with the row that is about to be removed and the row count before the removal: after the
   * next update focus moves to the row that took its place, else to the row above it, else to the
   * add button, so focus is never lost to the page.
   */
  readonly focusAfterRemove: (index: number, rowCountBefore: number) => void
}

/**
 * Focus management of the field arrays: after a row is added, focus moves to its first field;
 * after a row is removed, to the neighbouring row or the add button. Focus is moved after the
 * fields have rendered (`fields` changes), because the new row's inputs do not exist before.
 */
export function useFieldArrayFocus(fields: readonly unknown[]): FieldArrayFocus {
  const rowsRef = useRef<HTMLUListElement>(null)
  const addRef = useRef<HTMLButtonElement>(null)
  const pending = useRef<PendingFocus | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: the effect must run after every change of the fields array
  useEffect(() => {
    const target = pending.current
    if (target === null) return
    pending.current = null
    if (target.kind === 'add') {
      addRef.current?.focus()
      return
    }
    const row = rowsRef.current?.querySelectorAll(':scope > li').item(target.index)
    row?.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled)')?.focus()
  }, [fields])

  const focusRowAfterUpdate = useCallback((index: number) => {
    pending.current = { kind: 'row', index }
  }, [])

  const focusAfterRemove = useCallback((index: number, rowCountBefore: number) => {
    const remaining = rowCountBefore - 1
    pending.current =
      remaining <= 0 ? { kind: 'add' } : { kind: 'row', index: Math.min(index, remaining - 1) }
  }, [])

  return { rowsRef, addRef, focusRowAfterUpdate, focusAfterRemove }
}
