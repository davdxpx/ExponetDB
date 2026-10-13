import { createFileRoute } from '@tanstack/react-router'
import { OperationPage } from '../../../../features/changes/operation-page.tsx'

/**
 * `/changes/operations/<id>`: the operation page. The id must match
 * `op_<ULID>` exactly, else "page not found" renders and nothing is requested.
 */
export const Route = createFileRoute('/_app/changes/operations/$operationId')({
  component: OperationRoute,
})

function OperationRoute() {
  const { operationId } = Route.useParams()
  return <OperationPage operationId={operationId} />
}
