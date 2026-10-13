import { createFileRoute } from '@tanstack/react-router'
import { ConsentPage } from '../../../features/consent/consent-page.tsx'

/**
 * `/oauth/consent#request=exar_…`: the decision on a pending authorization
 * request, for a signed-in person (outside the shell). The handle is read
 * from the fragment by the page; without a session the API client leaves
 * for the sign-in page with this address (handle included) as `returnTo`.
 */
export const Route = createFileRoute('/_session/oauth/consent')({
  component: ConsentPage,
})
