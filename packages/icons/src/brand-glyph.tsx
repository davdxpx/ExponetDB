import type { ReactNode, SVGProps } from 'react'
import { BRAND_GLYPHS, type BrandId } from './provider-glyphs.ts'

export interface BrandGlyphProps
  extends Omit<SVGProps<SVGSVGElement>, 'children' | 'viewBox' | 'role' | 'fill' | 'ref'> {
  readonly brand: BrandId
  /** Width and height in pixels (default 16). */
  readonly size?: number
  /**
   * An accessible name. Without one the glyph is decorative and hidden from assistive technology,
   * which is right whenever the brand's name is written next to it.
   */
  readonly label?: string
}

/**
 * A provider's brand glyph (ADR-0033): an inline SVG on a 24 x 24 view box, in the brand color,
 * or in the text color where the brand color is too dark or too light on a theme (`mono`). No
 * request leaves the page: the path data is part of the bundle.
 */
export function BrandGlyph({ brand, size = 16, label, ...props }: BrandGlyphProps): ReactNode {
  const glyph = BRAND_GLYPHS[brand]
  return (
    <svg
      width={size}
      height={size}
      {...props}
      viewBox="0 0 24 24"
      role="img"
      aria-hidden={label === undefined ? true : undefined}
      aria-label={label}
      focusable="false"
      fill={glyph.mono ? 'currentColor' : `#${glyph.hex}`}
      data-brand={brand}
    >
      <path d={glyph.path} />
    </svg>
  )
}
