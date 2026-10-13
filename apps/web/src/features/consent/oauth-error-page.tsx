import { Admonition, useLinkComponent } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { InterstitialLayout, ProductTile } from '../../layouts/interstitial-layout.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { authorizeError } from '../../lib/navigation/links.ts'
import { useRawSearch } from './raw-location.ts'

/**
 * `/oauth/error?reason=…` (oauth.md §4): where the authorization endpoint
 * sends the browser while it cannot trust the client's redirect. The page
 * shows the fixed text of a known reason (`AUTHORIZE_ERRORS`) or a fixed
 * fallback, and nothing of the query itself. It needs no session.
 */
export function OAuthErrorPage(): ReactNode {
  const Link = useLinkComponent()
  const reason = authorizeError(useRawSearch())
  return (
    <InterstitialLayout logo={<ProductTile />} title={t('oauthError.title')}>
      <div className="flex flex-col gap-4 px-6 pb-6">
        <Admonition
          type="warning"
          description={
            <>
              <p id="oauth-error">{reason}</p>
              <p>{t('oauthError.next')}</p>
            </>
          }
        />
        <p className="text-center text-sm">
          <Link href="/" className="focus-ring rounded-sm text-foreground underline">
            {t('oauthError.home')}
          </Link>
        </p>
      </div>
    </InterstitialLayout>
  )
}
