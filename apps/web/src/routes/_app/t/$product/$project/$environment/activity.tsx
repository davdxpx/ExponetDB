import { createFileRoute } from '@tanstack/react-router'
import { TargetSectionPage } from '../../../../../../features/target/section-page.tsx'

/** `/t/<product>/<project>/<environment>/activity` */
export const Route = createFileRoute('/_app/t/$product/$project/$environment/activity')({
  component: () => <TargetSectionPage section="activity" />,
})
