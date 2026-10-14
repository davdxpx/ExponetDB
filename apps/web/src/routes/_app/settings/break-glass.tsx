import { createFileRoute } from '@tanstack/react-router'
import { BreakGlassPage } from '../../../features/settings/break-glass-page.tsx'

/** Break-glass grants and their post-incident review; activation stays refused (OD-21). */
export const Route = createFileRoute('/_app/settings/break-glass')({
  component: BreakGlassPage,
})
