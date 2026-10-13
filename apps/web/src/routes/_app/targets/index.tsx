import { createFileRoute } from '@tanstack/react-router'
import { targetsSearch } from '../../../features/targets/model.ts'
import { TargetsPage } from '../../../features/targets/targets-page.tsx'

/** `/targets`: all targets; search, filters, sort and view live in validated search parameters. */
export const Route = createFileRoute('/_app/targets/')({
  validateSearch: targetsSearch,
  component: TargetsRoute,
})

function TargetsRoute() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <TargetsPage
      search={search}
      onSearch={(next) => void navigate({ search: next, replace: true })}
    />
  )
}
