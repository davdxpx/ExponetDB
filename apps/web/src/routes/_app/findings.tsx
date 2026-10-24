import { createFileRoute } from '@tanstack/react-router'
import { GlobalFindingsPage } from '../../features/global-findings/findings-page.tsx'
import { globalFindingsSearch } from '../../features/global-findings/search.ts'

/**
 * `/findings[?severity=&state=&kind=&target=]`: the findings across every database the person
 * may read. The filters are allowlist values (a target as a path that passed the slug grammar).
 */
export const Route = createFileRoute('/_app/findings')({
  validateSearch: globalFindingsSearch,
  component: FindingsRoute,
})

function FindingsRoute() {
  const search = Route.useSearch()
  return <GlobalFindingsPage search={search} />
}
