// Derived from supabase/supabase packages/ui-patterns/src/CommandMenu/api/CommandMenuInput.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { CommandInput, cn } from '@exponetdb/ui'
import {
  type ComponentPropsWithoutRef,
  type ComponentRef,
  forwardRef,
  useEffect,
  useRef,
  useState,
} from 'react'

import { useCommandMenuQuery, useSetCommandMenuQuery } from './hooks/query-hooks.ts'

/** Below this width the on-screen keyboard would cover the list, so the field is not focused for the person. */
const NARROW_VIEWPORT = '(max-width: 639px)'

const isNarrowViewport = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia(NARROW_VIEWPORT).matches

const CommandMenuInput = forwardRef<
  ComponentRef<typeof CommandInput>,
  ComponentPropsWithoutRef<typeof CommandInput>
>(({ className, wrapperClassName, ...props }, ref) => {
  const query = useCommandMenuQuery()
  const setQuery = useSetCommandMenuQuery()

  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (!isNarrowViewport()) inputRef.current?.focus()
  }, [])

  // The field shows what is typed, also in the middle of an IME composition, but the
  // search only changes when a composition is finished.
  const [inputValue, setInputValue] = useState(query)
  const composing = useRef(false)
  useEffect(() => {
    if (!composing.current) setInputValue(query)
  }, [query])

  return (
    <CommandInput
      // Focus is handled above, because it depends on the width of the screen.
      autoFocus={false}
      ref={(element) => {
        inputRef.current = element
        if (typeof ref === 'function') ref(element)
        else if (ref) ref.current = element
      }}
      value={inputValue}
      onValueChange={(value) => {
        setInputValue(value)
        if (!composing.current) setQuery(value)
      }}
      onCompositionStart={() => {
        composing.current = true
      }}
      onCompositionEnd={(event) => {
        composing.current = false
        setQuery(event.currentTarget.value)
      }}
      placeholder="Search commands"
      wrapperClassName={cn('px-4 pr-10', wrapperClassName)}
      className={cn(
        'flex h-12 w-full rounded-md border-0 bg-transparent px-2 text-base text-foreground-light outline-hidden placeholder:text-foreground-muted focus:shadow-none focus:ring-transparent disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
})

CommandMenuInput.displayName = 'CommandMenuInput'

export { CommandMenuInput }
