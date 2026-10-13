import { createFileRoute } from '@tanstack/react-router'
import { EnvironmentsPage } from '../../../features/settings/environments-page.tsx'

/** Environments per product: tiers, order and evidence chain; changes are plans. */
export const Route = createFileRoute('/_app/settings/environments')({
  component: EnvironmentsPage,
})
