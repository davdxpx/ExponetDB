import { createFileRoute } from '@tanstack/react-router'
import { NotFoundPage } from '../../shell/not-found.tsx'

/** Any path below the shell that no page claims: "page not found" inside the shell. */
export const Route = createFileRoute('/_app/$')({
  component: () => <NotFoundPage />,
})
