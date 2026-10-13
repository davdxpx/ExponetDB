import { createFileRoute } from '@tanstack/react-router'
import { t } from '../lib/i18n/i18n.ts'

export const Route = createFileRoute('/')({
  component: () => <h1>{t('app.name')}</h1>,
})
