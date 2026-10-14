import { createFileRoute, redirect } from '@tanstack/react-router'

/** `/infrastructure`: the section's first page, Servers (information-architecture.md §2.1). */
export const Route = createFileRoute('/_app/infrastructure/')({
  beforeLoad: () => {
    throw redirect({ to: '/infrastructure/servers', replace: true })
  },
})
