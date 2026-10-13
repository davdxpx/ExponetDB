// Derived from supabase/supabase packages/ui/src/components/shadcn/ui/input-otp.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { Dot } from '@exponetdb/icons'
import { OTPInput, OTPInputContext, REGEXP_ONLY_DIGITS_AND_CHARS } from 'input-otp'
import * as React from 'react'

import { cn } from './lib/utils.ts'

/**
 * The `input-otp` library creates a `<style id="input-otp-style">` element at
 * run time unless an element with that id already exists, and the Web App's
 * CSP (`style-src 'self'`) forbids inline styles. The library has no option to
 * turn that off (`noScriptCSSFallback` only controls a `<noscript><style>`).
 * So the rules it would inject belong in the static stylesheet of the design
 * system (the selection, autofill, iOS letter-spacing and pointer-events rules
 * on `[data-input-otp]`), and a marker element that is not a `<style>` makes
 * the library skip its injection. An insertion effect runs before the
 * library's own effect.
 */
const LIBRARY_STYLE_ID = 'input-otp-style'

function useStaticStylesheetMarker() {
  React.useInsertionEffect(() => {
    if (document.getElementById(LIBRARY_STYLE_ID)) return
    const marker = document.createElement('meta')
    marker.id = LIBRARY_STYLE_ID
    marker.name = 'input-otp-static-css'
    marker.content = 'The rules of the input-otp library are part of the static stylesheet.'
    document.head.appendChild(marker)
  }, [])
}

const InputOTP = React.forwardRef<
  React.ElementRef<typeof OTPInput>,
  React.ComponentPropsWithoutRef<typeof OTPInput>
>(({ className, containerClassName, ...props }, ref) => {
  useStaticStylesheetMarker()

  return (
    <OTPInput
      ref={ref}
      // No <noscript><style> fallback either: it is an inline style too.
      noScriptCSSFallback={null}
      containerClassName={cn('flex items-center gap-2 has-disabled:opacity-50', containerClassName)}
      className={cn('disabled:cursor-not-allowed', className)}
      {...props}
    />
  )
})
InputOTP.displayName = 'InputOTP'

const InputOTPGroup = React.forwardRef<
  React.ElementRef<'div'>,
  React.ComponentPropsWithoutRef<'div'>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('flex items-center', className)} {...props} />
))
InputOTPGroup.displayName = 'InputOTPGroup'

const InputOTPSlot = React.forwardRef<
  React.ElementRef<'div'>,
  React.ComponentPropsWithoutRef<'div'> & { index: number }
>(({ index, className, ...props }, ref) => {
  const inputOTPContext = React.useContext(OTPInputContext)
  const slot = inputOTPContext.slots[index]
  if (!slot) return null
  const { char, hasFakeCaret, isActive } = slot

  return (
    <div
      ref={ref}
      className={cn(
        'relative flex h-10 w-10 items-center justify-center border-y border-r border-input text-sm transition-all first:rounded-l-md first:border-l last:rounded-r-md',
        isActive && 'z-10 ring-2 ring-ring ring-offset-background',
        className,
      )}
      {...props}
    >
      {char}
      {hasFakeCaret && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-4 w-px animate-caret-blink bg-foreground duration-1000 motion-reduce:animate-none" />
        </div>
      )}
    </div>
  )
})
InputOTPSlot.displayName = 'InputOTPSlot'

const InputOTPSeparator = React.forwardRef<
  React.ElementRef<'div'>,
  React.ComponentPropsWithoutRef<'div'>
>(({ ...props }, ref) => (
  // Decorative: the code is one text box, so the dash between its slots says nothing to assistive technology.
  <div ref={ref} aria-hidden {...props}>
    <Dot aria-hidden />
  </div>
))
InputOTPSeparator.displayName = 'InputOTPSeparator'

export { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot, REGEXP_ONLY_DIGITS_AND_CHARS }
