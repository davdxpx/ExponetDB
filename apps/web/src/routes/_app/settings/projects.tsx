import { createFileRoute } from '@tanstack/react-router'
import { ProjectsPage } from '../../../features/settings/projects-page.tsx'

/** Projects of the registry; a new one and every change are plans. */
export const Route = createFileRoute('/_app/settings/projects')({
  component: ProjectsPage,
})
