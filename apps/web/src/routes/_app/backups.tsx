import { createFileRoute } from '@tanstack/react-router'
import { GlobalBackupsPage } from '../../features/wave9/global-backups-page.tsx'
import { globalBackupsSearch } from '../../features/wave9/model.ts'

/** `/backups[?state=]`: backup protection across clusters; `state` is one of the contract's values. */
export const Route = createFileRoute('/_app/backups')({
  validateSearch: globalBackupsSearch,
  component: BackupsRoute,
})

function BackupsRoute() {
  const search = Route.useSearch()
  return <GlobalBackupsPage search={search} />
}
