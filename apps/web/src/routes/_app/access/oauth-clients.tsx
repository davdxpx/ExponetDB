import { createFileRoute } from '@tanstack/react-router'
import { OAuthClientsPage } from '../../../features/access/oauth-clients-page.tsx'

/** OAuth clients and their review (oauth.md §3; was `/admin/clients`). */
export const Route = createFileRoute('/_app/access/oauth-clients')({
  component: OAuthClientsPage,
})
