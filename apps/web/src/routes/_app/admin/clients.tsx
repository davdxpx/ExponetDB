import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * The Wave 3B address of the OAuth clients page. It stays a sign-in return
 * target (`safeReturnTo`) and a link the CLI and older bookmarks use; it
 * replaces itself with the new address, so Back never lands on it again.
 */
export const Route = createFileRoute('/_app/admin/clients')({
  beforeLoad: () => {
    throw redirect({ to: '/access/oauth-clients', replace: true })
  },
})
