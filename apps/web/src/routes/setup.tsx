import { createFileRoute } from '@tanstack/react-router'
import { EnrollmentPage } from '../features/enrollment/enrollment-page.tsx'

/**
 * `/setup#token=exsu_…` (a page without a session). `main.tsx` took the token
 * from the fragment and removed it from the address bar before the router
 * started; the page redeems it from memory.
 */
export const Route = createFileRoute('/setup')({
  staticData: { title: 'enrollment.title.setup' },
  component: () => <EnrollmentPage page="/setup" />,
})
