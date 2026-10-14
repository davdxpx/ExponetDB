import { createFileRoute } from '@tanstack/react-router'
import { RolesPage } from '../../../features/access/roles-page.tsx'

/** Roles: the built-in role catalog and who holds each role at which scope. */
export const Route = createFileRoute('/_app/access/roles')({
  component: RolesPage,
})
