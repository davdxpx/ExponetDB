import { createFileRoute } from '@tanstack/react-router'
import { CertificatesPage } from '../../../features/infrastructure/certificates-page.tsx'

/** `/infrastructure/certificates`: the agent PKI, the PostgreSQL CA and certificate expiries. */
export const Route = createFileRoute('/_app/infrastructure/certificates')({
  component: CertificatesPage,
})
