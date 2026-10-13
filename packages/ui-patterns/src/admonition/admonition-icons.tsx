import { StatusIcon, type StatusIconProps } from '@exponetdb/ui'

import type { AdmonitionType } from './admonition-types.ts'

export type AdmonitionIconProps = Omit<StatusIconProps, 'variant' | 'hideBackground' | 'decorative'>

/**
 * The glyphs of the status icon of the UI package, bare and decorative: the text next to
 * them says the same thing. Each type has its own shape (circle with "i", check mark,
 * triangle, circle with "!"), so color is never the only signal.
 */
export const InfoIcon = (props: AdmonitionIconProps) => (
  <StatusIcon variant="info" hideBackground decorative {...props} />
)

export const SuccessIcon = (props: AdmonitionIconProps) => (
  <StatusIcon variant="success" hideBackground decorative {...props} />
)

export const WarningIcon = (props: AdmonitionIconProps) => (
  <StatusIcon variant="warning" hideBackground decorative {...props} />
)

/**
 * The icon of an admonition type, on its colored square. It keeps its accessible name
 * ("Warning", "Information") because an admonition without a title would otherwise carry
 * the type in color alone.
 */
export function AdmonitionTypeIcon({ type }: { type: AdmonitionType }) {
  return <StatusIcon variant={type} className="size-[23px] shrink-0 p-1" />
}
