import { createFileRoute } from '@tanstack/react-router'
import { GlobalBackupsPage } from '../../features/wave9/wave9-pages.tsx'

/** `/backups`: backup protection across clusters; a named "not available yet" state until Wave 9. */
export const Route = createFileRoute('/_app/backups')({
  component: GlobalBackupsPage,
})
