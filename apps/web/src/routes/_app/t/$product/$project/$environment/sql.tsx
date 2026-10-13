import { createFileRoute } from '@tanstack/react-router'
import { TargetSectionPage } from '../../../../../../features/target/section-page.tsx'

/** `/t/<product>/<project>/<environment>/sql` */
export const Route = createFileRoute('/_app/t/$product/$project/$environment/sql')({
  component: () => <TargetSectionPage section="sql" />,
})
