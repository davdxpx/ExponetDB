import { createFileRoute } from '@tanstack/react-router'
import { TargetBackupsPage } from '../../../../../../features/wave9/backups-page.tsx'

/** `/t/<product>/<project>/<environment>/backups`: the protection of the target's cluster, its backups, drills and restores. */
export const Route = createFileRoute('/_app/t/$product/$project/$environment/backups')({
  component: TargetBackupsPage,
})
