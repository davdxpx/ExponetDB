import { Input, Label } from '@exponetdb/ui'
import { type ReactNode, type RefObject, useId, useRef } from 'react'

import {
  type ConfirmDialogBaseProps,
  type ConfirmGate,
  ConfirmLayout,
  ConfirmRoot,
  useConfirmAction,
  useKeyedState,
} from './confirm-shell.tsx'
import { MarkedCode, markedCount } from './marked-code.tsx'
import {
  confirmationMismatch,
  confirmationMismatchMessage,
  isTypeable,
  matchesExpectedText,
} from './typed-match.ts'

export interface TypedConfirmDialogProps extends ConfirmDialogBaseProps {
  /**
   * The exact text the person types: a target path (`shop/platform/production`)
   * or an object name. Shown in full, with invisible and direction characters
   * made visible; matched exactly after NFC normalization (`typed-match.ts`).
   */
  readonly expectedText: string
  /** What the text is, for the field label: "the target path", "the table name". */
  readonly expectedTextName?: string
  /**
   * Changing it clears what the person typed, like a changed expected text or
   * tier does (pass the id or hash of what the dialog confirms).
   */
  readonly resetKey?: string
  /** Same promise rules as `ConfirmDialog`'s `onConfirm`. */
  readonly onConfirm: () => unknown
  readonly children?: ReactNode
}

/**
 * The third step of the confirmation ladder: the person types the target path
 * or the object name before the action becomes available. Enter in the field
 * confirms once the text matches. The typed text starts over each time the
 * dialog opens and whenever the expected text, the tier or `resetKey`
 * changes, so text typed for one change never confirms another.
 */
export function TypedConfirmDialog({
  open,
  defaultOpen,
  onOpenChange,
  trigger,
  ...props
}: TypedConfirmDialogProps): ReactNode {
  return (
    <ConfirmRoot
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      trigger={trigger}
      size="medium"
    >
      <TypedConfirmBody {...props} />
    </ConfirmRoot>
  )
}

function TypedConfirmBody({
  expectedText,
  expectedTextName,
  resetKey,
  onConfirm,
  children,
  ...layout
}: Omit<TypedConfirmDialogProps, 'open' | 'defaultOpen' | 'onOpenChange' | 'trigger'>): ReactNode {
  const action = useConfirmAction()
  const actionRef = useRef<HTMLButtonElement>(null)
  const typed = useTypedConfirmation(
    expectedText,
    JSON.stringify([layout.tier ?? null, resetKey ?? null]),
  )
  return (
    <ConfirmLayout
      {...layout}
      action={action}
      onConfirm={onConfirm}
      gate={typed.gate}
      actionRef={actionRef}
    >
      {children}
      <TypedConfirmationField
        expectedText={expectedText}
        expectedTextName={expectedTextName}
        typed={typed}
        busy={action.locked}
        actionRef={actionRef}
      />
    </ConfirmLayout>
  )
}

export interface TypedConfirmation {
  readonly value: string
  readonly tried: boolean
  readonly matches: boolean
  readonly gate: ConfirmGate
  readonly setValue: (value: string) => void
  readonly markTried: () => void
}

/**
 * The typed text of a confirmation, cleared in the same render whenever the
 * expected text or `bindingKey` changes.
 */
export function useTypedConfirmation(expectedText: string, bindingKey: string): TypedConfirmation {
  const [state, update] = useKeyedState(JSON.stringify([expectedText, bindingKey]), () => ({
    value: '',
    tried: false,
  }))
  const typeable = isTypeable(expectedText)
  const matches = typeable && matchesExpectedText(state.value, expectedText)
  const markTried = () => update((previous) => ({ ...previous, tried: true }))
  return {
    value: state.value,
    tried: state.tried,
    matches,
    gate: {
      ready: matches,
      reason: typeable
        ? 'Type the text exactly as shown to continue.'
        : 'The text contains a line break, which a text field cannot hold, so it cannot be confirmed here.',
      onBlockedAttempt: markTried,
    },
    setValue: (value) => update((previous) => ({ ...previous, value })),
    markTried,
  }
}

/** The label with the expected text, the field and the mismatch message. */
export function TypedConfirmationField({
  expectedText,
  expectedTextName,
  typed,
  busy,
  actionRef,
  initialFocus = true,
}: {
  readonly expectedText: string
  readonly expectedTextName?: string
  readonly typed: TypedConfirmation
  readonly busy: boolean
  readonly actionRef: RefObject<HTMLButtonElement | null>
  /** The dialog opens with focus in this field (the first field of a dialog). */
  readonly initialFocus?: boolean
}): ReactNode {
  const inputId = useId()
  const markedId = useId()
  const messageId = useId()
  const marked = markedCount(expectedText)
  const mismatch = confirmationMismatch(typed.value, expectedText)
  const showMismatch = typed.tried && mismatch !== null
  const describedBy = [marked > 0 ? markedId : null, messageId].filter((id) => id !== null)

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={inputId} className="leading-normal text-foreground">
        To confirm, type {expectedTextName === undefined ? 'the text' : expectedTextName}{' '}
        <MarkedCode text={expectedText} />
      </Label>
      {marked > 0 ? (
        <p id={markedId} className="text-xs text-foreground-light">
          {marked === 1 ? '1 character is marked' : `${marked} characters are marked`}: characters
          that are not visible are shown by code point, characters outside basic Latin are
          underlined. Type them too: a marked character is part of the text.
        </p>
      ) : null}
      <Input
        id={inputId}
        type="text"
        value={typed.value}
        readOnly={busy}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-invalid={showMismatch || undefined}
        aria-describedby={describedBy.join(' ')}
        data-confirm-initial-focus={initialFocus ? '' : undefined}
        className="font-mono"
        onChange={(event) => typed.setValue(event.target.value)}
        onKeyDown={(event) => {
          // The Enter that commits an input method's composition is not a confirmation
          // (Safari sends it after compositionend, with keyCode 229).
          if (
            event.key !== 'Enter' ||
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229
          ) {
            return
          }
          event.preventDefault()
          // Enter confirms through the action itself, so it is guarded the same way.
          if (typed.matches) actionRef.current?.click()
          else typed.markTried()
        }}
      />
      <p id={messageId} aria-live="polite" className="min-h-5 text-sm text-destructive">
        {!isTypeable(expectedText)
          ? typed.gate.reason
          : showMismatch
            ? confirmationMismatchMessage(mismatch)
            : ''}
      </p>
    </div>
  )
}
