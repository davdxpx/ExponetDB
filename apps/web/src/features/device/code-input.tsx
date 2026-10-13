import { cn } from '@exponetdb/ui'
import { type ReactNode, useState } from 'react'
import { codeLetters, USER_CODE_LENGTH } from './user-code.ts'

/**
 * The eight-cell code field of the device page (modeled on Studio's CLI
 * sign-in code): one real text input named `code` lies over eight cells
 * that show its letters. The input takes typing and pasting (dashes,
 * spaces and case do not matter) and keeps the letters only; the cells are
 * decoration and hidden from assistive technology, which reads the input.
 * No `maxlength` of eight: a pasted `BCDF-GHJK` has nine characters.
 */
const CELLS = Array.from({ length: USER_CODE_LENGTH }, (_, position) => position)
const HALF = USER_CODE_LENGTH / 2

export interface CodeInputProps {
  readonly id: string
  readonly value: string
  readonly onChange: (letters: string) => void
  readonly describedBy?: string
  readonly invalid?: boolean
  readonly disabled?: boolean
}

export function CodeInput({
  id,
  value,
  onChange,
  describedBy,
  invalid = false,
  disabled = false,
}: CodeInputProps): ReactNode {
  const [focused, setFocused] = useState(false)
  const active = Math.min(value.length, USER_CODE_LENGTH - 1)
  const cell = (position: number) => (
    <span
      key={position}
      data-cell={position}
      className={cn(
        'flex h-11 flex-1 items-center justify-center border-y border-r border-control bg-field text-xl text-foreground',
        (position === 0 || position === HALF) && 'rounded-l-md border-l',
        (position === HALF - 1 || position === USER_CODE_LENGTH - 1) && 'rounded-r-md',
        invalid && 'border-destructive-400',
        focused && position === active && 'relative z-10 ring-2 ring-ring',
      )}
    >
      {value.charAt(position)}
    </span>
  )
  return (
    <div className="relative">
      <div aria-hidden="true" className="flex items-center gap-2 font-mono">
        <div className="flex flex-1">{CELLS.slice(0, HALF).map(cell)}</div>
        <span className="text-foreground-lighter">-</span>
        <div className="flex flex-1">{CELLS.slice(HALF).map(cell)}</div>
      </div>
      <input
        id={id}
        name="code"
        type="text"
        value={value}
        disabled={disabled}
        autoComplete="off"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        inputMode="text"
        maxLength={16}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(event) => onChange(codeLetters(event.currentTarget.value))}
        className="absolute inset-0 h-full w-full cursor-text border-0 bg-transparent font-mono text-transparent caret-transparent outline-hidden selection:bg-transparent"
      />
    </div>
  )
}
