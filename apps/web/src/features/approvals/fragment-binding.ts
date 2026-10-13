import { useRouterState } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

/**
 * Pages whose subject is bound to the URL fragment (`/approvals#operation=`,
 * `/step-up#id=`, `/credentials#cluster=`): opening another such link in the
 * same tab changes only the fragment, which does not load the page again. The
 * page reloads instead (Appendix C, the Wave 3A rule of `main.ts`), so no
 * form or code field can act on the previous link's subject; and the page
 * reads its fragment once, when it mounts, so a re-render never moves it to
 * another subject before the reload.
 */
export const pageReload = {
  /** Loads the page again (replaced in tests; jsdom does not navigate). */
  reload: (): void => {
    window.location.reload()
  },
}

/** The fragment the page was opened with (`#…`, or `''`), fixed for the page's life. */
export function useFragmentBinding(): string {
  const hash = useRouterState({ select: (state) => state.location.hash })
  const [initial] = useState(() => (hash === '' ? '' : `#${hash.replace(/^#/, '')}`))
  useEffect(() => {
    const onHashChange = (): void => pageReload.reload()
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])
  return initial
}
