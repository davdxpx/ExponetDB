import { createFileRoute } from '@tanstack/react-router'
import { NodeDetailPage } from '../../../../features/infrastructure/node-detail.tsx'

/**
 * `/infrastructure/nodes/<id>`: one node agent. The id must match
 * `nod_<ULID>` exactly, else "page not found" renders and nothing is requested.
 */
export const Route = createFileRoute('/_app/infrastructure/nodes/$nodeId')({
  component: NodeRoute,
})

function NodeRoute() {
  const { nodeId } = Route.useParams()
  return <NodeDetailPage nodeId={nodeId} />
}
