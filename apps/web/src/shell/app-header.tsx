import { Database, Plug } from '@exponetdb/icons'
import { Button, cn, SidebarTrigger, Tooltip, TooltipContent, TooltipTrigger } from '@exponetdb/ui'
import { CommandMenuTriggerInput, useLinkComponent } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { TargetContextBar } from '../features/target/context-bar.tsx'
import { type TargetRoute, targetOfPathname } from '../features/target/params.ts'
import { useTarget } from '../features/target/queries.ts'
import { t } from '../lib/i18n/i18n.ts'
import type { ShellLevel } from './levels.ts'
import { targetHref } from './navigation.ts'
import { PathSeparator } from './path-separator.tsx'

/**
 * The bar across the top of every signed-in page, as Studio's header
 * (information-architecture.md §2): the mark that leads back to the fleet,
 * then the path of where the page is, each step divided by a slanted stroke —
 * the installation, and on a target's pages its product and project and its
 * environment with the tier and the health, each a switcher — then, at the
 * end, the target's Connect, the search and the account. The addresses stay
 * as they are; the path is only drawn here. On a phone a menu button opens
 * the rail as a sheet.
 */
export function AppHeader({
  level,
  pathname,
  accountMenu,
}: {
  readonly level: ShellLevel
  readonly pathname: string
  readonly accountMenu: ReactNode
}): ReactNode {
  const Link = useLinkComponent()
  const target = level === 'target' ? targetOfPathname(pathname) : undefined
  return (
    <header
      data-slot="app-header"
      className="flex h-12 min-w-0 shrink-0 items-center gap-1 border-b border-default bg-dash-sidebar pr-3 pl-2 md:pl-3"
    >
      <SidebarTrigger className="md:hidden" aria-label={t('shell.menu')} />
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            href="/"
            aria-label={t('shell.home')}
            className="flex size-8 shrink-0 items-center justify-center rounded-md focus-ring"
          >
            <span className="flex size-7 items-center justify-center rounded-md border border-strong bg-surface-100">
              <Database aria-hidden="true" className="size-4 text-foreground" strokeWidth={1.5} />
            </span>
          </Link>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('shell.home')}</TooltipContent>
      </Tooltip>
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        <PathStep className={cn(level === 'target' && 'max-md:hidden')}>
          <Link
            href="/"
            className="truncate rounded-md px-1 text-sm font-medium text-foreground focus-ring"
          >
            {t('app.name')}
          </Link>
        </PathStep>
        {level === 'target' ? <TargetContextBar /> : null}
        {level === 'account' ? (
          <PathStep>
            <span className="truncate px-1 text-sm text-foreground">{t('shell.account')}</span>
          </PathStep>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {target === undefined ? null : <ConnectButton target={target} />}
        <CommandMenuTriggerInput
          placeholder={t('shell.search')}
          className="rounded-full md:w-56 md:max-w-sm"
        />
        {accountMenu}
      </div>
    </header>
  )
}

/**
 * The target's Connect, as Studio's: it opens the target's connection details
 * (Configuration, `#connect`). A target the server does not know shows none.
 */
function ConnectButton({ target }: { readonly target: TargetRoute }): ReactNode {
  const Link = useLinkComponent()
  // The same read the layout and the context bar make (one query, one request).
  const read = useTarget(target.path)
  if (read.notFound) return null
  return (
    <Button
      asChild
      variant="default"
      size="tiny"
      className="rounded-full max-md:px-1.5"
      icon={<Plug aria-hidden="true" className="rotate-90" strokeWidth={1.5} />}
    >
      <Link href={`${targetHref(target, '/configuration')}#connect`}>
        <span className="max-md:sr-only">{t('shell.connect')}</span>
      </Link>
    </Button>
  )
}

/** A step of the path, after its separator. */
function PathStep({
  children,
  className,
}: {
  readonly children: ReactNode
  readonly className?: string
}): ReactNode {
  return (
    <span className={cn('flex min-w-0 items-center gap-1', className)}>
      <PathSeparator />
      {children}
    </span>
  )
}
