import { type ReactNode, useEffect, useState } from 'react'

/**
 * Renders one case and marks it ready once its interaction ran and two frames
 * passed, so portals, effects, animations and lazy chunks have settled before
 * the browser test reads the violations (apps/server/test/csp-ui-surface.e2e.test.ts).
 */
export function CaseFrame({
  name,
  act,
  children,
}: {
  name: string
  act?: (() => void | Promise<void>) | undefined
  children: ReactNode
}): ReactNode {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let alive = true
    const frame = (): Promise<void> =>
      new Promise((resolve) => requestAnimationFrame(() => resolve()))
    void (async () => {
      await frame()
      await act?.()
      await frame()
      await frame()
      if (alive) setReady(true)
    })()
    return () => {
      alive = false
    }
  }, [act])
  return (
    <section aria-label={name} data-csp-ready={ready ? 'true' : 'false'} className="p-6">
      {children}
    </section>
  )
}
