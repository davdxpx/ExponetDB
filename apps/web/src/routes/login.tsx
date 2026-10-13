import { createFileRoute, useRouterState } from '@tanstack/react-router'
import { returnToOf } from '../features/sign-in/sign-in-model.ts'
import { SignInPage } from '../features/sign-in/sign-in-page.tsx'

/**
 * `/login?returnTo=…` (a page without a session). `returnTo` is untrusted
 * text: the page decides it with `safeReturnTo` (an exact allowlist) only
 * when the sign-in succeeded. The router writes query values back in its
 * canonical form (it reads JSON in them); whatever comes out of that still
 * has to match the allowlist exactly, or the account page follows.
 */
export const Route = createFileRoute('/login')({
  component: LoginRoute,
})

function LoginRoute() {
  const search = useRouterState({ select: (state) => state.location.searchStr })
  return <SignInPage returnTo={returnToOf(search)} />
}
