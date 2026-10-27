import { createFileRoute } from '@tanstack/react-router'
import { AdvisorsPage } from '../../../../../../features/wave9/advisors-page.tsx'

/** `/t/<product>/<project>/<environment>/advisors`: live advisors and the open advisor findings. */
export const Route = createFileRoute('/_app/t/$product/$project/$environment/advisors')({
  component: AdvisorsPage,
})
