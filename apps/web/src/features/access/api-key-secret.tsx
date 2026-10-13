import { Button, copyToClipboard, toast } from '@exponetdb/ui'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'

/**
 * A new API key's secret, shown once (identity.md §5, C-20). The secret
 * comes only from the answer that created the key and lives only in the
 * page's component state: never in the query or mutation cache, the URL,
 * history state or storage, never logged and never in a toast. Hiding it,
 * leaving the page or reloading it ends it for good; a refresh of the list
 * never brings it back, because the list never holds it.
 */
export interface RevealedKey {
  readonly accountId: string
  readonly keyId: string
  readonly secret: string
}

export function ApiKeySecret({
  revealed,
  onHide,
}: {
  readonly revealed: RevealedKey
  readonly onHide: () => void
}): ReactNode {
  const copy = async (): Promise<void> => {
    if (await copyToClipboard(revealed.secret)) {
      toast.success(t('access.secret.copied'))
    } else {
      toast.error(t('access.secret.copyFailed'))
    }
  }
  return (
    <section
      aria-label={t('access.secret.region')}
      className="secret flex flex-col gap-3 rounded-md border border-warning-500 bg-warning-200 p-4"
    >
      <div aria-live="polite" className="flex flex-col gap-1">
        <p className="text-sm font-medium text-foreground">{t('access.secret.title')}</p>
        <p className="text-sm text-foreground-light">{t('access.secret.body')}</p>
      </div>
      <code
        id="api-key-secret"
        className="once select-all break-all rounded-sm bg-surface-100 px-2 py-1 font-mono text-sm text-foreground"
      >
        {revealed.secret}
      </code>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="default" size="small" onClick={() => void copy()}>
          {t('access.secret.copy')}
        </Button>
        <Button type="button" variant="text" size="small" onClick={onHide}>
          {t('access.secret.hide')}
        </Button>
      </div>
    </section>
  )
}
