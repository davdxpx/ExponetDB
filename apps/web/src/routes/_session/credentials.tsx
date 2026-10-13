import { createFileRoute } from '@tanstack/react-router'
import { CredentialsPage } from '../../features/credentials/credentials-page.tsx'

/** `/credentials#cluster=cls_…[&role=…]`: the write-only form for a role password of a cluster. */
export const Route = createFileRoute('/_session/credentials')({
  component: CredentialsPage,
})
