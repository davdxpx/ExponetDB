import { createFileRoute } from '@tanstack/react-router'
import { ProfilePage } from '../../../features/account/pages.tsx'

/** `/account`: a tab of the account area. */
export const Route = createFileRoute('/_app/account/')({
  component: ProfilePage,
})
