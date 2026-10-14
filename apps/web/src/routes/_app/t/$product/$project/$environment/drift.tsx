import { createFileRoute } from '@tanstack/react-router'
import { DriftPage } from '../../../../../../features/drift/drift-page.tsx'

/** `/t/<product>/<project>/<environment>/drift` */
export const Route = createFileRoute('/_app/t/$product/$project/$environment/drift')({
  component: DriftPage,
})
