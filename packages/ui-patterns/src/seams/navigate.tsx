import { createContext, type ReactNode, useContext } from 'react'

/**
 * Navigation requested by a pattern (a command menu entry, a row action). The
 * app supplies its router's navigate; without a provider the call does nothing,
 * so a pattern never changes `location` on its own. The path is an app path the
 * caller built from typed values, never one taken from untrusted content.
 */
export type Navigate = (path: string, options?: { replace?: boolean }) => void

/**
 * Whether a link or navigation target is a path inside the app: it starts
 * with one slash and holds no space, control character or backslash. The URL
 * parser drops tabs and line breaks and reads `\` as `/`, so `/\t/host` and
 * `/\host` would become `//host`, another origin. Targets come from typed
 * values the caller built; this is the second lock, so a value that slipped
 * through is never made into a link or a navigation (C-26).
 */
export function isAppPath(path: string): path is `/${string}` {
  if (!path.startsWith('/') || path.startsWith('//')) return false
  for (const character of path) {
    const cp = character.codePointAt(0) ?? 0
    if (cp < 0x21 || cp === 0x7f || character === '\\') return false
  }
  return true
}

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
