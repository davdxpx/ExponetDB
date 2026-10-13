import { createFileRoute } from '@tanstack/react-router'
import { connectSearch, DEFAULT_CLIENT, isClientId } from '../../features/connect/clients.ts'
import { ConnectPage } from '../../features/connect/connect-page.tsx'

/** `/connect[?client=<id>]`: connecting an MCP client; the client id is an allowlist value. */
export const Route = createFileRoute('/_app/connect')({
  validateSearch: connectSearch,
  component: ConnectRoute,
})

function ConnectRoute() {
  const { client } = Route.useSearch()
  // Checked again here: only an allowlisted id ever selects a client.
  return (
    <ConnectPage
      client={isClientId(client) ? client : DEFAULT_CLIENT}
      origin={window.location.origin}
    />
  )
}
