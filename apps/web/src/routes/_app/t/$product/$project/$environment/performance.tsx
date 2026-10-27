import { createFileRoute } from '@tanstack/react-router'
import { PerformancePage } from '../../../../../../features/wave9/performance-page.tsx'

/** `/t/<product>/<project>/<environment>/performance`: statement statistics and table and index health. */
export const Route = createFileRoute('/_app/t/$product/$project/$environment/performance')({
  component: PerformancePage,
})
