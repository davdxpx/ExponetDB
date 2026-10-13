import { createFileRoute } from '@tanstack/react-router'
import { TargetSectionPage } from '../../../../../../features/target/section-page.tsx'

/** `/t/<product>/<project>/<environment>`: the target overview. */
export const Route = createFileRoute('/_app/t/$product/$project/$environment/')({
  component: () => <TargetSectionPage section="overview" />,
})
