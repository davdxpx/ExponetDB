import { createFileRoute } from '@tanstack/react-router'
import { ConnectionsPage } from '../../../../../../features/connections/connections-page.tsx'
import { connectionsSearch } from '../../../../../../features/connections/search.ts'

/**
 * `/t/<product>/<project>/<environment>/connections[?state=&view=&sort=&layout=&minAge=]`:
 * each parameter is one of a fixed list of values, anything else is dropped.
 */
export const Route = createFileRoute('/_app/t/$product/$project/$environment/connections')({
  validateSearch: connectionsSearch,
  component: ConnectionsRoute,
})

function ConnectionsRoute() {
  const search = Route.useSearch()
  return <ConnectionsPage search={search} />
}
