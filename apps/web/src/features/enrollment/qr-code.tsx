import type { ReactNode } from 'react'
import { qrPath } from '../../lib/navigation/links.ts'

/** The quiet zone around the modules, in modules (ISO/IEC 18004). */
const QUIET = 4

/**
 * A QR code drawn locally as one inline SVG path from the server's module
 * matrix (`TotpSetup.qr`): no image library, no QR service, no image
 * request, no inline style. The rows are `0`/`1` text the server validated;
 * only the dark modules become path data built from numbers. Dark on light
 * in both themes, so a camera can always read it; the colors are SVG
 * presentation attributes, not CSS.
 */
export function QrCode({
  rows,
  size,
  label,
}: {
  readonly rows: readonly string[]
  readonly size: number
  readonly label: string
}): ReactNode {
  const extent = size + QUIET * 2
  return (
    <svg
      className="qr size-48 shrink-0 rounded-md border border-default"
      viewBox={`0 0 ${extent} ${extent}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={extent} height={extent} fill="#ffffff" />
      <path d={qrPath(rows, QUIET)} fill="#000000" />
    </svg>
  )
}
