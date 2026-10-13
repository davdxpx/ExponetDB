import {
  isAppPath,
  type LinkComponentProps,
  LinkProvider,
  linkableHref,
  NavigateProvider,
} from '@exponetdb/ui-patterns'
import { type ReactNode, useSyncExternalStore } from 'react'

/**
 * The design-system app's routing: a static site with a handful of pages, so
 * a path switch over `location` instead of a router package (the router lives
 * in `apps/web` only, graph.json). Links and navigation reach the patterns
 * through the ui-patterns seams.
 */
const CHANGE = 'exdb-ds-navigate'

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange)
  window.addEventListener(CHANGE, onChange)
  return () => {
    window.removeEventListener('popstate', onChange)
    window.removeEventListener(CHANGE, onChange)
  }
}

export interface Location {
  readonly path: string
  readonly search: string
}

let cached: Location = { path: '/', search: '' }

function snapshot(): Location {
  const { pathname, search } = window.location
  if (cached.path !== pathname || cached.search !== search) {
    cached = { path: pathname, search }
  }
  return cached
}

export function useLocation(): Location {
  return useSyncExternalStore(subscribe, snapshot, () => cached)
}

export function navigate(path: string, options?: { replace?: boolean }): void {
  if (!isAppPath(path)) return
  if (options?.replace === true) window.history.replaceState(null, '', path)
  else window.history.pushState(null, '', path)
  window.dispatchEvent(new Event(CHANGE))
}

function AppLink({ href, onClick, ref, ...props }: LinkComponentProps): ReactNode {
  return (
    <a
      ref={ref}
      href={linkableHref(href)}
      onClick={(event) => {
        onClick?.(event)
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
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

export function RoutingProvider({ children }: { children: ReactNode }): ReactNode {
  return (
    <LinkProvider component={AppLink}>
      <NavigateProvider navigate={navigate}>{children}</NavigateProvider>
    </LinkProvider>
  )
}
