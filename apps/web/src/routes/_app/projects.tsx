import { createFileRoute } from '@tanstack/react-router'
import { projectsSearch } from '../../features/projects/model.ts'
import { ProjectsPage } from '../../features/projects/projects-page.tsx'

/** `/projects`: the portfolio; search, product, view and page live in validated search parameters. */
export const Route = createFileRoute('/_app/projects')({
  staticData: { title: 'projects.title' },
  validateSearch: projectsSearch,
  component: ProjectsRoute,
})

function ProjectsRoute() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <ProjectsPage
      search={search}
      onSearch={(next) => void navigate({ search: next, replace: true })}
    />
  )
}
