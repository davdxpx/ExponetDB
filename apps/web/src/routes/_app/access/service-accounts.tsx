import { createFileRoute } from '@tanstack/react-router'
import { ServiceAccountsPage } from '../../../features/access/service-accounts-page.tsx'

/** Service accounts, their keys, machine grants and API keys (identity.md §5; was `/admin/service-accounts`). */
export const Route = createFileRoute('/_app/access/service-accounts')({
  component: ServiceAccountsPage,
})
