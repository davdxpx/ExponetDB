import { useRouter } from '@tanstack/react-router'
import { useSyncExternalStore } from 'react'

/**
 * The fragment and the query string exactly as the address bar has them.
 * The router's parsed location decodes both (and keeps only the part after
 * the last `#`), so a page that matches a fragment or a query against an
 * exact grammar (`requestHandle`, `authorizeError`) reads the history's raw
 * values instead: an encoded or doubled fragment never passes as a valid
 * one. Both follow navigation inside the app and `hashchange`.
 */
export function useRawHash(): string {
  const router = useRouter()
  return useSyncExternalStore(
    (onChange) => router.history.subscribe(onChange),
    () => router.history.location.hash,
    () => '',
  )
}

export function useRawSearch(): string {
  const router = useRouter()
  return useSyncExternalStore(
    (onChange) => router.history.subscribe(onChange),
    () => router.history.location.search,
    () => '',
  )
}
