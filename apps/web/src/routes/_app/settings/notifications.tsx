import { createFileRoute } from '@tanstack/react-router'
import { NotificationsPage } from '../../../features/settings/notifications-page.tsx'

/** Notification channels: a named state until OD-21 is decided. */
export const Route = createFileRoute('/_app/settings/notifications')({
  component: NotificationsPage,
})
