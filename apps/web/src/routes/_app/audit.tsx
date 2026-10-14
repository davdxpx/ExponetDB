import { createFileRoute } from '@tanstack/react-router'
import { AuditPage } from '../../features/audit/audit-page.tsx'
import { auditSearch } from '../../features/audit/search.ts'

/** `/audit[?filters]`: audit search, chain verification and export; each filter is an allowlisted shape. */
export const Route = createFileRoute('/_app/audit')({
  validateSearch: auditSearch,
  component: AuditRoute,
})

function AuditRoute() {
  const search = Route.useSearch()
  // Checked again here: only values of the API's exact shapes reach a request.
  return <AuditPage search={auditSearch(search)} />
}
