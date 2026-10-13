import { createFileRoute } from '@tanstack/react-router'
import { MigrationsPage } from '../../../../../../features/migrations/migrations-page.tsx'
import { reportSearch } from '../../../../../../features/migrations/model.ts'

/** `/t/<product>/<project>/<environment>/migrations[?report=imr_…]`: the ledger, timeline, plans, drift and legacy import. */
export const Route = createFileRoute('/_app/t/$product/$project/$environment/migrations')({
  validateSearch: reportSearch,
  component: MigrationsRoute,
})

function MigrationsRoute() {
  const { report } = Route.useSearch()
  return <MigrationsPage report={report} />
}
