import { createFileRoute } from '@tanstack/react-router'
import { OAuthErrorPage } from '../../features/consent/oauth-error-page.tsx'

/** `/oauth/error?reason=…`: fixed text for the reason, the query never echoed; no session needed. */
export const Route = createFileRoute('/oauth/error')({
  staticData: { title: 'oauthError.title' },
  component: OAuthErrorPage,
})
