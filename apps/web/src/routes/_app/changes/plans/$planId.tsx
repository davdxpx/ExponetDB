import { createFileRoute } from '@tanstack/react-router'
import { PlanPage } from '../../../../features/plans/plan-page.tsx'

/**
 * `/changes/plans/<id>`: the plan review page. The id must match `pln_<ULID>`
 * exactly, else "page not found" renders and nothing is requested.
 */
export const Route = createFileRoute('/_app/changes/plans/$planId')({
  component: PlanReviewRoute,
})

function PlanReviewRoute() {
  const { planId } = Route.useParams()
  return <PlanPage planId={planId} />
}
