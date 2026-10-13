import { createContext, type ReactNode, useContext } from 'react'

/**
 * Navigation requested by a pattern (a command menu entry, a row action). The
 * app supplies its router's navigate; without a provider the call does nothing,
 * so a pattern never changes `location` on its own. The path is an app path the
 * caller built from typed values, never one taken from untrusted content.
 */
export type Navigate = (path: string, options?: { replace?: boolean }) => void

const noNavigation: Navigate = () => {}

const NavigateContext = createContext<Navigate>(noNavigation)

export function NavigateProvider({
  navigate,
  children,
}: {
  navigate: Navigate
  children: ReactNode
}): ReactNode {
  return <NavigateContext.Provider value={navigate}>{children}</NavigateContext.Provider>
}

export function useNavigate(): Navigate {
  return useContext(NavigateContext)
}
