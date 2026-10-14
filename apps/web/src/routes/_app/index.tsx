import { createFileRoute } from '@tanstack/react-router'
import { FleetPage } from '../../features/fleet/fleet-page.tsx'

/** `/`: the fleet overview (information-architecture.md section 2). */
export const Route = createFileRoute('/_app/')({
  component: FleetPage,
})
