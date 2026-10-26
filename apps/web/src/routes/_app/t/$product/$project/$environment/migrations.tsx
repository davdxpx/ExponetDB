import { createFileRoute } from '@tanstack/react-router'
import { migrationsSearch } from '../../../../../../features/migrations/history-model.ts'
import { MigrationsPage } from '../../../../../../features/migrations/migrations-page.tsx'

/**
 * `/t/<product>/<project>/<environment>/migrations[?view=…&q=…&origin=…&verification=…&sort=…&page=…&size=…&migration=…&report=imr_…]`:
 * the migration centre; every value is validated, anything else is dropped.
 */
export const Route = createFileRoute('/_app/t/$product/$project/$environment/migrations')({
  validateSearch: migrationsSearch,
  component: MigrationsRoute,
})

function MigrationsRoute() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <MigrationsPage
      search={search}
      onSearch={(next) => void navigate({ search: next, replace: true })}
    />
  )
}
