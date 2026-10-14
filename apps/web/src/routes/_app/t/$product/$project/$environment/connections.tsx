import { createFileRoute } from '@tanstack/react-router'
import { ConnectionsPage } from '../../../../../../features/connections/connections-page.tsx'

/** `/t/<product>/<project>/<environment>/connections` */
export const Route = createFileRoute('/_app/t/$product/$project/$environment/connections')({
  component: ConnectionsPage,
})
