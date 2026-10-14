import { createFileRoute } from '@tanstack/react-router'
import { Wave9TargetPage } from '../../../../../../features/wave9/wave9-pages.tsx'

/** `/t/<product>/<project>/<environment>/backups`: a named "not available yet" state until Wave 9. */
export const Route = createFileRoute('/_app/t/$product/$project/$environment/backups')({
  component: () => <Wave9TargetPage section="backups" />,
})
