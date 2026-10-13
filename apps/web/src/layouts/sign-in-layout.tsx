import type { ReactNode } from 'react'
import { t } from '../lib/i18n/i18n.ts'

export interface SignInLayoutProps {
  /** The page's `h1` ("Sign in", "Set up your account"). */
  readonly heading: string
  /** One sentence under the heading. */
  readonly subheading?: string
  /** Text below the form (a hint, a link to recovery). */
  readonly footer?: ReactNode
  readonly children: ReactNode
}

/**
 * The frame of the pages a person sees before a session exists: sign-in,
 * setup, invite and recovery (order §8, modeled on Studio's sign-in layout
 * without its testimonial panel, remote images or marketing links). The
 * text mark of the installation on top, one centered column with the
 * heading and the form, and the page in a `main` landmark. Nothing here
 * reads the URL or the session: the pages pass text only.
 */
export function SignInLayout({
  heading,
  subheading,
  footer,
  children,
}: SignInLayoutProps): ReactNode {
  return (
    <div className="flex min-h-screen flex-col bg-alternative">
      <header className="flex h-14 items-center px-6">
        <span className="text-base font-semibold text-foreground">{t('app.name')}</span>
      </header>
      <main className="flex flex-1 flex-col items-center px-5 pt-10 pb-8">
        <div className="flex w-full max-w-sm flex-1 flex-col justify-center gap-8">
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-medium tracking-tight text-foreground text-balance">
              {heading}
            </h1>
            {subheading === undefined ? null : (
              <p className="text-sm text-foreground-light">{subheading}</p>
            )}
          </div>
          {children}
        </div>
        {footer === undefined ? null : (
          <div className="mt-8 max-w-sm text-center text-xs text-foreground-lighter text-balance">
            {footer}
          </div>
        )}
      </main>
    </div>
  )
}
