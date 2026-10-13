import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * The Wave 3B address of the service accounts page. It stays a sign-in
 * return target (`safeReturnTo`); it replaces itself with the new address,
 * so Back never lands on it again.
 */
export const Route = createFileRoute('/_app/admin/service-accounts')({
  beforeLoad: () => {
    throw redirect({ to: '/access/service-accounts', replace: true })
  },
})
