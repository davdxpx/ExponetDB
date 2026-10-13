import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { t } from '../lib/i18n/i18n.ts'

/**
 * "Page not found" for a path no route knows. It never redirects and never
 * shows the address it was given (the address is input, C-26). Inside the
 * shell the page is already in the `main` landmark, so it renders a `div`;
 * outside the shell it is the landmark itself.
 */
export function NotFoundPage({ landmark = false }: { readonly landmark?: boolean }): ReactNode {
  const Root = landmark ? 'main' : 'div'
  return (
    <Root className="mx-auto flex max-w-xl flex-col gap-3 p-6">
      <h1 className="text-2xl font-semibold">{t('page.notFound.title')}</h1>
      <p>{t('page.notFound.body')}</p>
      <p>
        <Link to="/" className="text-primary underline">
          {t('page.notFound.back')}
        </Link>
      </p>
    </Root>
  )
}
