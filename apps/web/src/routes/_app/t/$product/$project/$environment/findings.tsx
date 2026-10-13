import { createFileRoute } from '@tanstack/react-router'
import { FindingsPage } from '../../../../../../features/findings/findings-page.tsx'
import { findingsSearch } from '../../../../../../features/findings/search.ts'

/** `/t/<product>/<project>/<environment>/findings[?severity=&state=&kind=]`: filters are allowlist values. */
export const Route = createFileRoute('/_app/t/$product/$project/$environment/findings')({
  validateSearch: findingsSearch,
  component: FindingsRoute,
})

function FindingsRoute() {
  const search = Route.useSearch()
  return <FindingsPage search={search} />
}
