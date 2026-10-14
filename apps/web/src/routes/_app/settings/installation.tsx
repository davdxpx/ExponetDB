import { createFileRoute } from '@tanstack/react-router'
import { InstallationPage } from '../../../features/settings/installation-page.tsx'

/** The installation and the health of the Control Plane. */
export const Route = createFileRoute('/_app/settings/installation')({
  component: InstallationPage,
})
