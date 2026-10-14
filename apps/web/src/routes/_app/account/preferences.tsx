import { createFileRoute } from '@tanstack/react-router'
import { PreferencesPage } from '../../../features/account/pages.tsx'

/** `/account/preferences`: a tab of the account area. */
export const Route = createFileRoute('/_app/account/preferences')({
  component: PreferencesPage,
})
