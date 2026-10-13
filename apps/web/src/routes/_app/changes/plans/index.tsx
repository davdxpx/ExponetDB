import { createFileRoute } from '@tanstack/react-router'
import { PlanListPage } from '../../../../features/plans/plan-list.tsx'

/** `/changes/plans`: the plans the person may read, each linked to its review page. */
export const Route = createFileRoute('/_app/changes/plans/')({
  component: PlanListPage,
})
