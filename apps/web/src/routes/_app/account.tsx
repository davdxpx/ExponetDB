import { createFileRoute } from '@tanstack/react-router'
import { AccountPage } from '../../features/account/account-page.tsx'

/** `/account`: the signed-in person's own account, inside the shell. */
export const Route = createFileRoute('/_app/account')({
  staticData: { title: 'account.title' },
  component: AccountPage,
})
