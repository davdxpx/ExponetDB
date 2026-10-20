import { createBrowserHistory, createRouter, type RouterHistory } from '@tanstack/react-router'
import { parseSearch, stringifySearch } from '../lib/navigation/search.ts'
import { routeTree } from '../routeTree.gen.ts'
import { RouteErrorPage } from './error-page.tsx'

/**
 * The router of the Web App, the same in the page and in the tests.
 *
 * - Query values are plain strings (`parseSearch`, `stringifySearch`): the
 *   router's default JSON reading is off, so a quoted or JSON-looking value
 *   never turns into another value before an allowlist sees it.
 * - The fragment stays as the address bar has it (`keepRawFragment`): on
 *   load the router writes its own canonical location back, with the
 *   fragment percent-decoded; a fragment-bound page matches the raw
 *   fragment against an exact grammar (`useRawHash`), so an encoded handle
 *   must not become a valid one by the router's rewrite.
 *
 * - A route that fails to render shows the crash page (`RouteErrorPage`), in
 *   place of the page only, so the shell around it stays; the router's own
 *   fallback would print the exception's message, which can hold data.
 *
 * One-time link tokens never reach the router: `holdOneTimeLink` removes
 * them from the address bar and the history before it is created.
 */
export function createAppRouter(history: RouterHistory = createBrowserHistory()) {
  return createRouter({
    routeTree,
    history: keepRawFragment(history),
    defaultErrorComponent: RouteErrorPage,
    defaultPreload: 'intent',
    parseSearch,
    stringifySearch,
  })
}

function decoded(fragment: string): string {
  try {
    return decodeURIComponent(fragment)
  } catch {
    return fragment
  }
}

function fragmentOf(path: string): { readonly rest: string; readonly hash: string } {
  const at = path.indexOf('#')
  return at === -1 ? { rest: path, hash: '' } : { rest: path.slice(0, at), hash: path.slice(at) }
}

/**
 * A history that keeps the raw fragment when the router writes back the
 * same fragment in decoded form (the canonical rewrite of a load). Any
 * other fragment is written as given.
 */
export function keepRawFragment(history: RouterHistory): RouterHistory {
  const keep = (path: string): string => {
    const raw = history.location.hash
    const next = fragmentOf(path)
    if (raw === '' || next.hash === raw || decoded(next.hash) !== decoded(raw)) return path
    return `${next.rest}${raw}`
  }
  const push = history.push
  const replace = history.replace
  history.push = (path, state, options) => push(keep(path), state, options)
  history.replace = (path, state, options) => replace(keep(path), state, options)
  return history
}

export type AppRouter = ReturnType<typeof createAppRouter>
