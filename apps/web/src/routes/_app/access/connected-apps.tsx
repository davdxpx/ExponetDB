import { createFileRoute } from '@tanstack/react-router'
import { ConnectedAppsPage } from '../../../features/access/connected-apps-page.tsx'

/** Connected applications of every person, for administrators (`GET /grants`). */
export const Route = createFileRoute('/_app/access/connected-apps')({
  component: ConnectedAppsPage,
})
