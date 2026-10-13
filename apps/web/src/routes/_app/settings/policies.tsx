import { createFileRoute } from '@tanstack/react-router'
import { PoliciesPage } from '../../../features/settings/policies-page.tsx'

/** Policy rules and settings, the data-read policy per tier first; changes are plans. */
export const Route = createFileRoute('/_app/settings/policies')({
  component: PoliciesPage,
})
