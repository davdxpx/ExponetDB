import { createFileRoute } from '@tanstack/react-router'
import { operationsSearch } from '../../../../features/changes/model.ts'
import { OperationsPage } from '../../../../features/changes/operations-page.tsx'

/** `/changes/operations`: the operations list; state, kind and actor live in validated search parameters. */
export const Route = createFileRoute('/_app/changes/operations/')({
  validateSearch: operationsSearch,
  component: OperationsRoute,
})

function OperationsRoute() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <OperationsPage
      search={search}
      onSearch={(next) =>
        void navigate({
          search: { state: next.state, kind: next.kind, actor: next.actor },
          replace: true,
        })
      }
    />
  )
}
