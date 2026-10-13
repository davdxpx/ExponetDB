import { createFileRoute } from '@tanstack/react-router'
import { DevicePage } from '../../../features/device/device-page.tsx'

/** `/oauth/device`: the person types the code their device shows (never taken from a link). */
export const Route = createFileRoute('/_session/oauth/device')({
  component: DevicePage,
})
