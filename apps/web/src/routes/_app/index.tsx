import { createFileRoute } from '@tanstack/react-router'
import { t } from '../../lib/i18n/i18n.ts'

export const Route = createFileRoute('/_app/')({
  component: () => (
    <div className="p-6">
      <h1 className="text-2xl font-semibold">{t('page.overview.title')}</h1>
    </div>
  ),
})
