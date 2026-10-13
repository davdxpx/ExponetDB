import { TooltipProvider } from '@exponetdb/ui'
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'

/** The badges explain themselves in tooltips; the app shell provides the provider. */
export function renderPlan(ui: ReactElement): ReturnType<typeof render> {
  return render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>)
}

export const HASH = `sha256:${'ab12'.repeat(16)}`
export const OTHER_HASH = `sha256:${'cd34'.repeat(16)}`
export const PLAN_ID = 'pln_01JABCDEFGHJKMNPQRSTVWXYZ0'
export const OPERATION_ID = 'op_01JABCDEFGHJKMNPQRSTVWXYZ0'
export const PROD_PATH = 'shop/platform/production'
export const CREATED_AT = '2026-10-13T14:00:00.000Z'
export const EXPIRES_AT = '2026-10-13T14:15:00.000Z'
/** Four and a half minutes before the expiry. */
export const BEFORE_EXPIRY = '2026-10-13T14:10:30.000Z'

/** Hostile characters, written as braced escapes so no raw invisible character is in the source. */
export const RLO = '\u{202E}'
export const ZWSP = '\u{200B}'
export const TAG_A = '\u{E0041}'
