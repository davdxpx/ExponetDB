import { createFileRoute } from '@tanstack/react-router'
import { TargetLayout } from '../../../../../features/target/layout.tsx'

/**
 * `/t/<product>/<project>/<environment>`: the layout of every target page.
 * It validates the three parameters against the slug grammar, reads the
 * target and renders the sections navigation around the page.
 */
export const Route = createFileRoute('/_app/t/$product/$project/$environment')({
  component: TargetLayoutPage,
})

function TargetLayoutPage() {
  return <TargetLayout params={Route.useParams()} />
}
