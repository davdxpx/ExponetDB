import { createFileRoute } from '@tanstack/react-router'
import { ActivityPage } from '../../../../../../features/activity/activity-page.tsx'

/** `/t/<product>/<project>/<environment>/activity` */
export const Route = createFileRoute('/_app/t/$product/$project/$environment/activity')({
  component: ActivityPage,
})
