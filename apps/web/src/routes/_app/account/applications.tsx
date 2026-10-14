import { createFileRoute } from '@tanstack/react-router'
import { ApplicationsPage } from '../../../features/account/pages.tsx'

/** `/account/applications`: a tab of the account area. */
export const Route = createFileRoute('/_app/account/applications')({
  component: ApplicationsPage,
})
