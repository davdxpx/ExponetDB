import { createFileRoute } from '@tanstack/react-router'
import { Wave9TargetPage } from '../../../../../../features/wave9/wave9-pages.tsx'

/** `/t/<product>/<project>/<environment>/performance`: a named "not available yet" state until Wave 9. */
export const Route = createFileRoute('/_app/t/$product/$project/$environment/performance')({
  component: () => <Wave9TargetPage section="performance" />,
})
