import { createFileRoute } from '@tanstack/react-router'
import { ChangesPage } from '../../../features/changes/changes-page.tsx'

/** `/changes`: all changes, linking plans, operations, approvals and the promotion view. */
export const Route = createFileRoute('/_app/changes/')({
  component: ChangesPage,
})
