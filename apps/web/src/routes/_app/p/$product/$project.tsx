import { createFileRoute } from '@tanstack/react-router'
import { ProjectPage } from '../../../../features/projects/project-page.tsx'

/** `/p/<product>/<project>`: a project's home (ADR-0035); the slugs are checked by the page. */
export const Route = createFileRoute('/_app/p/$product/$project')({
  staticData: { title: 'projects.title' },
  component: ProjectRoute,
})

function ProjectRoute() {
  const { product, project } = Route.useParams()
  return <ProjectPage product={product} project={project} />
}
