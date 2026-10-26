import { formatCount, type PagerText } from '@exponetdb/ui-patterns'
import { t } from '../i18n/i18n.ts'

/** The pager's words from the active message catalog (OD-1). */
export const pagerText = (): PagerText => ({
  previous: t('pager.previous'),
  next: t('pager.next'),
  range: (from, to, total) =>
    t('pager.range', { from: formatCount(from), to: formatCount(to), total: formatCount(total) }),
  page: (page, pages) => t('pager.page', { page: formatCount(page), pages: formatCount(pages) }),
  pageSize: t('pager.pageSize'),
})
