import { createFileRoute } from '@tanstack/react-router'
import { ConfigurationPage } from '../../../../../../features/configuration/configuration-page.tsx'

/** `/t/<product>/<project>/<environment>/configuration` */
export const Route = createFileRoute('/_app/t/$product/$project/$environment/configuration')({
  component: ConfigurationPage,
})
