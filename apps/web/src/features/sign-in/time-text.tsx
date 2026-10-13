import { formatUtc, toIso } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'

/**
 * A point in time from the server as a `<time>` element in a fixed UTC shape
 * (`2026-10-13 14:03 UTC`), the same in every locale; a value that is not a
 * date reads "Unknown time" and is never shown as it came.
 */
export function TimeText({ value }: { readonly value: string }): ReactNode {
  const text = formatUtc(value)
  const iso = toIso(value)
  if (text === undefined || iso === undefined) return <span>{t('account.time.unknown')}</span>
  return <time dateTime={iso}>{text}</time>
}
