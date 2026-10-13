import { createFileRoute } from '@tanstack/react-router'
import { ServerDetailPage } from '../../../../features/infrastructure/server-detail.tsx'

/**
 * `/infrastructure/servers/<id>`: one server. The id must match `srv_<ULID>`
 * exactly, else "page not found" renders and nothing is requested.
 */
export const Route = createFileRoute('/_app/infrastructure/servers/$serverId')({
  component: ServerRoute,
})

function ServerRoute() {
  const { serverId } = Route.useParams()
  return <ServerDetailPage serverId={serverId} />
}
