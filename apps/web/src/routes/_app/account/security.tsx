import { createFileRoute } from '@tanstack/react-router'
import { SecurityPage } from '../../../features/account/security-page.tsx'

/** `/account/security`: a tab of the account area. */
export const Route = createFileRoute('/_app/account/security')({
  component: SecurityPage,
})
