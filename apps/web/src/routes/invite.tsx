import { createFileRoute } from '@tanstack/react-router'
import { EnrollmentPage } from '../features/enrollment/enrollment-page.tsx'

/**
 * `/invite#token=exiv_…` (a page without a session). `main.tsx` took the token
 * from the fragment and removed it from the address bar before the router
 * started; the page redeems it from memory.
 */
export const Route = createFileRoute('/invite')({
  component: () => <EnrollmentPage page="/invite" />,
})
