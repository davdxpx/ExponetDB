import { createFileRoute } from '@tanstack/react-router'
import { TargetSectionPage } from '../../../../../../features/target/section-page.tsx'

/** `/t/<product>/<project>/<environment>/drift` */
export const Route = createFileRoute('/_app/t/$product/$project/$environment/drift')({
  component: () => <TargetSectionPage section="drift" />,
})
