import { isCurrent } from './navigation.ts'

/**
 * The level a page belongs to, as Supabase Studio has an organization level, a
 * project level and the account (information-architecture.md §2): the fleet
 * (every page about many targets, the default), one target (every page below
 * `/t/<product>/<project>/<environment>`) and the person's own account. The
 * rail lists the sections of the level, the header names it.
 */
export type ShellLevel = 'fleet' | 'target' | 'account'

export function shellLevel(pathname: string): ShellLevel {
  if (isCurrent('/account', pathname)) return 'account'
  if (isCurrent('/t', pathname)) return 'target'
  return 'fleet'
}
