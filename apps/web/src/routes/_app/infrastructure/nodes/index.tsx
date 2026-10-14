import { createFileRoute } from '@tanstack/react-router'
import { NodesPage } from '../../../../features/infrastructure/nodes-page.tsx'

/** `/infrastructure/nodes`: the node agents and the enrollment tokens to reveal. */
export const Route = createFileRoute('/_app/infrastructure/nodes/')({
  component: NodesPage,
})
