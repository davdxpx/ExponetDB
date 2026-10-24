import { Button } from '@exponetdb/ui'
import { EmptyState } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'

/**
 * What a list says when a filter leaves no row of a read that succeeded and
 * did hold some: "No match", with the way back. It is not the empty state of
 * a read that found nothing (that one says the read succeeded and the list is
 * empty), and a failed read never reaches it.
 */
export function NoMatch({ onReset }: { readonly onReset: () => void }): ReactNode {
  return (
    <div data-no-match="">
      <EmptyState title={t('noMatch.title')} description={t('noMatch.body')} headingLevel={2}>
        <Button type="button" variant="default" size="small" onClick={onReset}>
          {t('noMatch.reset')}
        </Button>
      </EmptyState>
    </div>
  )
}
