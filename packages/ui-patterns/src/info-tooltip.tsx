// Derived from supabase/supabase packages/ui-patterns/src/info-tooltip.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import {
  StatusIcon,
  Tooltip,
  TooltipContent,
  type TooltipContentProps,
  TooltipTrigger,
} from '@exponetdb/ui'

export type InfoTooltipProps = TooltipContentProps & {
  /** The accessible name of the button that opens the tooltip. */
  label?: string
}

/**
 * A small "i" button that explains something in a tooltip. The tooltip opens on hover and on
 * keyboard focus, closes with Escape and is linked to the button with `aria-describedby`. It
 * describes; the information a person needs to act must also be on the page. Needs the app's
 * `TooltipProvider`.
 */
export function InfoTooltip({ label = 'More information', ...props }: InfoTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger type="button" className="focus-ring flex rounded-full">
        <StatusIcon
          variant="info"
          hideBackground
          decorative
          className="size-4 text-foreground-muted transition-colors motion-reduce:transition-none"
        />
        <span className="sr-only">{label}</span>
      </TooltipTrigger>
      <TooltipContent {...props} />
    </Tooltip>
  )
}
