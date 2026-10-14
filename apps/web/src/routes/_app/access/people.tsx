import { createFileRoute } from '@tanstack/react-router'
import { PeoplePage } from '../../../features/access/people-page.tsx'

/** People: identities with their role bindings, invitations and administration (identity.md). */
export const Route = createFileRoute('/_app/access/people')({
  component: PeoplePage,
})
