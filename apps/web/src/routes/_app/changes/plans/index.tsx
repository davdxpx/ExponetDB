import { createFileRoute } from '@tanstack/react-router'
import { planListSearch } from '../../../../features/plans/list-model.ts'
import { PlanListPage } from '../../../../features/plans/plan-list.tsx'

/**
 * `/changes/plans`: the plans the person may read, each linked to its review
 * page; state, kind, creator, target and "awaiting approval" live in
 * validated search parameters.
 */
export const Route = createFileRoute('/_app/changes/plans/')({
  validateSearch: planListSearch,
  component: PlanListRoute,
})

function PlanListRoute() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <PlanListPage
      search={search}
      onSearch={(next) =>
        void navigate({
          search: {
            state: next.state,
            kind: next.kind,
            actor: next.actor,
            target: next.target,
            awaiting: next.awaiting,
          },
          replace: true,
        })
      }
    />
  )
}
