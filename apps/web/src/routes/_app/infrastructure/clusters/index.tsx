import { createFileRoute } from '@tanstack/react-router'
import { ClustersPage } from '../../../../features/infrastructure/clusters-page.tsx'

/** `/infrastructure/clusters`: the PostgreSQL clusters of the registry. */
export const Route = createFileRoute('/_app/infrastructure/clusters/')({
  component: ClustersPage,
})
