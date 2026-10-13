import { createFileRoute } from '@tanstack/react-router'
import { ActivityPage } from '../../../features/account/pages.tsx'

/** `/account/activity`: a tab of the account area. */
export const Route = createFileRoute('/_app/account/activity')({
  component: ActivityPage,
})
