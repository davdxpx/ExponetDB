import { ArrowRightLeft } from '@exponetdb/icons'
import { Card, cn } from '@exponetdb/ui'
import type { ReactNode } from 'react'
import { t } from '../lib/i18n/i18n.ts'

export interface InterstitialLayoutProps {
  /** A tile or a pair of tiles above the title (`LogoTile`, `LogoPair`). */
  readonly logo?: ReactNode
  /** The page's `h1`. */
  readonly title: string
  readonly description?: string
  /** Text beneath the card, at the card's width. */
  readonly footer?: ReactNode
  /** The card and footer width; 400 px by default (order Appendix A). */
  readonly width?: 'default' | 'wide'
  readonly children: ReactNode
}

/**
 * A full-screen centered card for interstitial steps: authorizing a client,
 * the device code, step-up confirmation, the credentials hand-off (order §8
 * and Appendix A, modeled on Studio's interstitial layout). The logo row,
 * the title and the description sit in the card's header so every step
 * looks the same; the page is the `main` landmark. No size animation: the
 * card simply takes its new height.
 */
export function InterstitialLayout({
  logo,
  title,
  description,
  footer,
  width = 'default',
  children,
}: InterstitialLayoutProps): ReactNode {
  const widthClass = width === 'wide' ? 'max-w-[560px]' : 'max-w-[400px]'
  return (
    <main className="flex min-h-screen w-full items-center justify-center bg-dash-canvas px-2 py-6">
      <div className={cn('flex w-full flex-col items-center gap-4', widthClass)}>
        <Card className="w-full overflow-hidden">
          <div className="flex flex-col items-center px-6 py-6 text-center">
            {logo === undefined ? null : <div className="mb-4 flex justify-center">{logo}</div>}
            <h1 className="text-lg font-medium tracking-tight text-foreground text-balance">
              {title}
            </h1>
            {description === undefined ? null : (
              <p className="mt-1 px-3 text-sm leading-tight text-foreground-lighter text-balance">
                {description}
              </p>
            )}
          </div>
          {children}
        </Card>
        {footer === undefined ? null : (
          <div className="px-2 text-center text-xs text-foreground-lighter text-balance">
            {footer}
          </div>
        )}
      </div>
    </main>
  )
}

/** A 48 px rounded tile for a logo row. */
export function LogoTile({
  children,
  className,
}: {
  readonly children: ReactNode
  readonly className?: string
}): ReactNode {
  return (
    <div
      className={cn(
        'flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-default bg-muted',
        className,
      )}
    >
      {children}
    </div>
  )
}

/** Two tiles with the exchange arrow between them ("this client ⇄ ExponetDB"). */
export function LogoPair({
  left,
  right,
}: {
  readonly left: ReactNode
  readonly right: ReactNode
}): ReactNode {
  return (
    <div className="flex items-center justify-center gap-2.5">
      {left}
      <ArrowRightLeft aria-hidden="true" className="size-4 text-foreground-muted" />
      {right}
    </div>
  )
}

/**
 * The first letter or digit of a name, upper-cased, or `?` when the name has
 * none. Only that one character of an untrusted name is shown here (never a
 * remote image, never markup); the full name is rendered elsewhere through
 * the untrusted-text patterns.
 */
export function initialOf(name: string): string {
  const match = /[\p{L}\p{N}]/u.exec(name)
  return match === null ? '?' : match[0].toLocaleUpperCase('en-US')
}

/** A neutral tile with the initial of a client's name (no remote logo, order §8). */
export function InitialTile({ name }: { readonly name: string }): ReactNode {
  return (
    <LogoTile>
      <span aria-hidden="true" className="text-lg font-medium text-foreground-light">
        {initialOf(name)}
      </span>
    </LogoTile>
  )
}

/** The installation's own tile: its text mark's initial. */
export function ProductTile(): ReactNode {
  return <InitialTile name={t('app.name')} />
}
