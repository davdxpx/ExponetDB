import { type MessageKey, t } from '../lib/i18n/i18n.ts'
import { GLOBAL_NAV, isCurrent, TARGET_NAV } from '../shell/navigation.ts'

/**
 * The document title of every page: "<Page> · ExponetDB" (the Wave 3A app
 * used "Sign in · ExponetDB"), or the product name alone where a page has
 * no name. A route names its page with `staticData.title` (a message key);
 * a page of the navigation (information-architecture.md §2) is named by its
 * navigation label, a target page by its target section. Nothing from the
 * address or from data ever goes into the title.
 */
declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    /** The page's name in the document title and the browser history. */
    readonly title?: MessageKey
  }
}

export function formatTitle(page: string | undefined): string {
  const app = t('app.name')
  return page === undefined || page === '' ? app : t('title.page', { page, app })
}

const TARGET_PAGE = /^\/t\/[^/]+\/[^/]+\/[^/]+(\/[^/]+)?/

/** The navigation label of a path, or undefined when the navigation does not name it. */
export function navigationLabel(pathname: string): string | undefined {
  const target = TARGET_PAGE.exec(pathname)
  if (target !== null) {
    const suffix = target[1] ?? ''
    return TARGET_NAV.find((section) => section.suffix === suffix)?.label
  }
  // The longest matching page (`/changes` and `/changes/plans`).
  return GLOBAL_NAV.filter((item) => isCurrent(item.path, pathname)).sort(
    (a, b) => b.path.length - a.path.length,
  )[0]?.label
}

/**
 * The title for a location: the deepest route that names its page wins,
 * then the navigation's label for the path, then the product name alone.
 */
export function titleOf(
  pathname: string,
  routeTitles: readonly (MessageKey | undefined)[],
): string {
  const named = routeTitles.filter((key) => key !== undefined).at(-1)
  return formatTitle(named === undefined ? navigationLabel(pathname) : t(named))
}
