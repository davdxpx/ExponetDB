import { createFileRoute } from '@tanstack/react-router'
import { AccountArea } from '../../features/account/account-area.tsx'

/** `/account`: the signed-in person's own account area (tabs below it), inside the shell. */
export const Route = createFileRoute('/_app/account')({
  staticData: { title: 'account.title' },
  component: AccountArea,
})
