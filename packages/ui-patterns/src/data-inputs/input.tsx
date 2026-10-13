// Derived from supabase/supabase packages/ui-patterns/src/DataInputs/Input.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { Copy } from '@exponetdb/icons'
import {
  cn,
  copyToClipboard,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  type InputProps,
  toast,
} from '@exponetdb/ui'
import { forwardRef, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'

/** How long the copy button says "Copied" before it says "Copy" again. */
const COPIED_LABEL_MS = 3000

export interface DataInputProps extends Omit<InputProps, 'onCopy'> {
  /** Shows a copy button that puts the current value on the clipboard. Not available for `type="password"`. */
  copy?: boolean
  /** Shows the copy button only while the pointer or focus is on the input. */
  showCopyOnHover?: boolean
  /** Called after the value has been copied with the copy button. */
  onCopied?: () => void
  /** Shown before the value. Decorative: it is hidden from assistive technology by its container. */
  icon?: ReactNode
  /** More actions at the end of the input. */
  actions?: ReactNode
  containerClassName?: string
}

/**
 * A text input with an optional copy button, a leading icon and trailing actions: the display of a
 * value people copy (a target path, a plan hash, a connection host).
 *
 * A secret is never shown again, so there is no reveal control: a `type="password"` input stays
 * masked and has no copy button. Copying announces its result with a toast ("Copied to the
 * clipboard"), and the button says "Copied" for a few seconds.
 */
export const DataInput = forwardRef<HTMLInputElement, DataInputProps>(
  (
    {
      copy,
      showCopyOnHover = false,
      icon,
      actions,
      onCopied,
      containerClassName,
      className,
      size = 'small',
      onFocus,
      ...props
    },
    forwardedRef,
  ) => {
    const [copied, setCopied] = useState(false)
    const inputRef = useRef<HTMLInputElement | null>(null)
    const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

    useEffect(() => () => clearTimeout(resetTimer.current), [])

    const setRefs = useCallback(
      (element: HTMLInputElement | null) => {
        inputRef.current = element
        if (typeof forwardedRef === 'function') forwardedRef(element)
        else if (forwardedRef) forwardedRef.current = element
      },
      [forwardedRef],
    )

    const canCopy = copy === true && props.type !== 'password'

    const onCopyClick = async () => {
      const text = inputRef.current?.value ?? ''
      if (text === '') {
        toast.info('There is nothing to copy')
        return
      }
      if (await copyToClipboard(text)) {
        toast.success('Copied to the clipboard')
        setCopied(true)
        clearTimeout(resetTimer.current)
        resetTimer.current = setTimeout(() => setCopied(false), COPIED_LABEL_MS)
        onCopied?.()
      } else {
        toast.error('Could not copy to the clipboard')
      }
    }

    const inputName = props['aria-label']

    return (
      <InputGroup className={containerClassName}>
        <InputGroupInput
          ref={setRefs}
          {...props}
          size={size}
          className={className}
          onFocus={(event) => {
            // A value that is shown to be copied is selected as a whole; an editable one is not.
            if (props.readOnly) event.target.select()
            onFocus?.(event)
          }}
          autoComplete="off"
          data-1p-ignore // password managers must not treat a data input as a credential field
          data-lpignore="true"
          data-form-type="other"
          data-bwignore
        />
        {icon ? (
          <InputGroupAddon align="inline-start" aria-hidden>
            {icon}
          </InputGroupAddon>
        ) : null}
        {canCopy || actions ? (
          <InputGroupAddon
            align="inline-end"
            // Override defaults
            className="pr-1 has-[>button]:mr-0 has-[>kbd]:mr-0"
          >
            {canCopy ? (
              <InputGroupButton
                size="tiny"
                variant="default"
                className={cn(
                  showCopyOnHover &&
                    'opacity-0 group-hover/input-group:opacity-100 group-focus-within/input-group:opacity-100 focus-visible:opacity-100 transition',
                )}
                icon={<Copy size={16} className="text-foreground-muted" />}
                aria-label={inputName ? `${copied ? 'Copied' : 'Copy'} ${inputName}` : undefined}
                disabled={props.disabled}
                onClick={onCopyClick}
              >
                {copied ? 'Copied' : 'Copy'}
              </InputGroupButton>
            ) : null}
            {actions}
          </InputGroupAddon>
        ) : null}
      </InputGroup>
    )
  },
)
DataInput.displayName = 'DataInput'
