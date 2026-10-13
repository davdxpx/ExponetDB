import { createFileRoute } from '@tanstack/react-router'
import { EnrollmentPage } from '../features/enrollment/enrollment-page.tsx'

/**
 * `/recover#token=exrc_…` (a page without a session). `main.tsx` took the token
 * from the fragment and removed it from the address bar before the router
 * started; the page redeems it from memory.
 */
export const Route = createFileRoute('/recover')({
  staticData: { title: 'enrollment.title.recover' },
  component: () => <EnrollmentPage page="/recover" />,
})
