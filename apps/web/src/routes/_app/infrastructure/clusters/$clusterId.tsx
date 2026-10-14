import { createFileRoute } from '@tanstack/react-router'
import { ClusterDetailPage } from '../../../../features/infrastructure/cluster-detail.tsx'

/**
 * `/infrastructure/clusters/<id>`: one cluster. The id must match
 * `cls_<ULID>` exactly, else "page not found" renders and nothing is requested.
 */
export const Route = createFileRoute('/_app/infrastructure/clusters/$clusterId')({
  component: ClusterRoute,
})

function ClusterRoute() {
  const { clusterId } = Route.useParams()
  return <ClusterDetailPage clusterId={clusterId} />
}
