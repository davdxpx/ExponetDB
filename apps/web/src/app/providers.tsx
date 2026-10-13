import { Toaster, TooltipProvider } from '@exponetdb/ui'
import {
  isAppPath,
  type LinkComponentProps,
  LinkProvider,
  type Navigate,
  NavigateProvider,
} from '@exponetdb/ui-patterns'
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type ReactNode, useMemo } from 'react'
import { type ReauthBridge, ReauthHost } from '../features/reauth/reauth.tsx'
import type { ApiClient } from '../lib/api/client.ts'
import { ApiProvider } from '../lib/api/context.tsx'

/**
 * Everything a page needs from the app, in one place: the query cache, the
 * API client with its re-authentication dialog, the router's links and
 * navigation for the design-system patterns (the seams of ui-patterns),
 * tooltips and the toaster. The pieces are created once in `main.tsx`.
 */
export interface AppServices {
  readonly queryClient: QueryClient
  readonly client: ApiClient
  readonly reauth: ReauthBridge
  /** App-internal navigation (the router's); paths are built from typed values only. */
  readonly navigate: Navigate
}

export function AppProviders({
  services,
  children,
}: {
  readonly services: AppServices
  readonly children: ReactNode
}): ReactNode {
  const { queryClient, client, reauth, navigate } = services
  const appLink = useMemo(() => routerLink(navigate), [navigate])
  return (
    <QueryClientProvider client={queryClient}>
      <ApiProvider value={{ client, confirmIdentity: reauth.confirmIdentity }}>
        <LinkProvider component={appLink}>
          <NavigateProvider navigate={navigate}>
            <TooltipProvider delayDuration={300}>
              {children}
              <ReauthHost bridge={reauth} />
              <Toaster />
            </TooltipProvider>
          </NavigateProvider>
        </LinkProvider>
      </ApiProvider>
    </QueryClientProvider>
  )
}

/** An `<a href>` that navigates inside the app on a plain left click and leaves every other click to the browser. */
export function routerLink(navigate: Navigate): (props: LinkComponentProps) => ReactNode {
  return function AppLink({ href, onClick, ref, ...props }: LinkComponentProps): ReactNode {
    return (
      <a
        ref={ref}
        href={href}
        onClick={(event) => {
          onClick?.(event)
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey ||
            props.target !== undefined ||
            !isAppPath(href)
          ) {
            return
          }
          event.preventDefault()
          navigate(href)
        }}
        {...props}
      />
    )
  }
}
