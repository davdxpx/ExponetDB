import { createFileRoute } from '@tanstack/react-router'
import { ComparePage } from '../../../../../../features/compare/compare-page.tsx'
import { compareSearch } from '../../../../../../features/compare/model.ts'

/**
 * `/t/<product>/<project>/<environment>/compare[?to=<environment>]`: the
 * schema of this target against another environment of the project, read
 * only. `to` must be a slug; the page checks it against the project's
 * environments before it asks for a comparison.
 */
export const Route = createFileRoute('/_app/t/$product/$project/$environment/compare')({
  validateSearch: compareSearch,
  staticData: { title: 'compare.title' },
  component: CompareRoute,
})

function CompareRoute() {
  const { to } = Route.useSearch()
  return <ComparePage to={to} />
}
