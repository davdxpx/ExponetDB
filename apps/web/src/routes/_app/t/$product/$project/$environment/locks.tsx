import { createFileRoute } from '@tanstack/react-router'
import { LocksPage } from '../../../../../../features/connections/locks-page.tsx'

/** `/t/<product>/<project>/<environment>/locks` */
export const Route = createFileRoute('/_app/t/$product/$project/$environment/locks')({
  component: LocksPage,
})
