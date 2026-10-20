// Derived from supabase/supabase packages/ui/src/components/hooks/use-mobile.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import * as React from 'react'

const MOBILE_BREAKPOINT = 768
const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(QUERY)
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}

function snapshot(): boolean {
  return window.innerWidth < MOBILE_BREAKPOINT
}

/**
 * Whether the viewport is below the phone breakpoint. Read during render
 * (`useSyncExternalStore`), so the first render already has the right layout:
 * the copied version started `false` and corrected itself in an effect, which
 * showed one frame of the desktop layout on phones (G8 record §8). The app is
 * client-only, so there is no server snapshot to reconcile.
 */
export function useIsMobile(): boolean {
  return React.useSyncExternalStore(subscribe, snapshot, () => false)
}
