import { createFileRoute } from '@tanstack/react-router'
import { ServersPage } from '../../../../features/infrastructure/servers-page.tsx'

/** `/infrastructure/servers`: the servers of the registry and "Register server". */
export const Route = createFileRoute('/_app/infrastructure/servers/')({
  component: ServersPage,
})
