import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
  Label,
  REGEXP_ONLY_DIGITS_AND_CHARS,
} from '@exponetdb/ui'
import { type ReactNode, useId, useState } from 'react'
import type { DemoDefinition } from '../types.ts'
import { Stack } from './support.tsx'

function DeviceCode(): ReactNode {
  const id = useId()
  const [value, setValue] = useState('')
  return (
    <Stack className="max-w-sm">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id} className="text-foreground-light">
          Code from the terminal
        </Label>
        <InputOTP
          id={id}
          maxLength={8}
          pattern={REGEXP_ONLY_DIGITS_AND_CHARS}
          value={value}
          onChange={(next) => setValue(next.toUpperCase())}
          autoComplete="off"
        >
          <InputOTPGroup>
            <InputOTPSlot index={0} />
            <InputOTPSlot index={1} />
            <InputOTPSlot index={2} />
            <InputOTPSlot index={3} />
          </InputOTPGroup>
          <InputOTPSeparator />
          <InputOTPGroup>
            <InputOTPSlot index={4} />
            <InputOTPSlot index={5} />
            <InputOTPSlot index={6} />
            <InputOTPSlot index={7} />
          </InputOTPGroup>
        </InputOTP>
        <p className="text-xs text-foreground-lighter">Letters and digits, 8 characters.</p>
      </div>
      <p role="status" className="text-sm text-foreground-light">
        {value.length === 8 ? 'The code is complete.' : `${value.length} of 8 characters.`}
      </p>
    </Stack>
  )
}

function Digits(): ReactNode {
  const id = useId()
  const [value, setValue] = useState('428')
  return (
    <div className="flex max-w-sm flex-col gap-1.5">
      <Label htmlFor={id} className="text-foreground-light">
        Confirmation code
      </Label>
      <InputOTP
        id={id}
        maxLength={6}
        pattern="^[0-9]*$"
        inputMode="numeric"
        value={value}
        onChange={setValue}
      >
        <InputOTPGroup>
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <InputOTPSlot key={index} index={index} />
          ))}
        </InputOTPGroup>
      </InputOTP>
    </div>
  )
}

function Disabled(): ReactNode {
  const id = useId()
  return (
    <div className="flex max-w-sm flex-col gap-1.5">
      <Label htmlFor={id} className="text-foreground-light">
        Code from the terminal, waiting
      </Label>
      <InputOTP id={id} maxLength={4} disabled value="K7QD">
        <InputOTPGroup>
          {[0, 1, 2, 3].map((index) => (
            <InputOTPSlot key={index} index={index} />
          ))}
        </InputOTPGroup>
      </InputOTP>
    </div>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui/input-otp/device-code',
    title: 'A code of letters and digits in two groups, with progress as text',
    render: () => <DeviceCode />,
  },
  { id: 'ui/input-otp/digits', title: 'Digits only, partly typed', render: () => <Digits /> },
  { id: 'ui/input-otp/disabled', title: 'Disabled', render: () => <Disabled /> },
]
