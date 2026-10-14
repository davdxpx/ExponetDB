import type { NodeCertificates } from '@exponetdb/sdk/operations'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import { MarkedCode, NotPermittedState, ReadableView, UntrustedName } from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { certificatesQuery } from './keys.ts'
import { NODE_CERT_WARNING_HOURS, nodePath, serverPath } from './model.ts'
import { Expiry, InfraPage, InfraSection, NodeStateBadge, ObjectLink } from './parts.tsx'

/**
 * `/infrastructure/certificates` (`GET /nodes/certificates`, `nodes.read`):
 * the certificate authorities of the agent PKI and the PostgreSQL CA with
 * their validity window and SHA-256 fingerprint, each node's client
 * certificate expiry and the server certificate expiries its agent last
 * reported. What the store cannot know (the gateway's in-memory leaf, the
 * server certificates of external clusters) and authorities it does not
 * hold yet are listed as such. Never a key or a certificate itself.
 */
export function CertificatesPage(): ReactNode {
  const { client } = useApi()
  const read = useQuery(certificatesQuery(client))
  return (
    <InfraPage
      title={t('infra.certificates.title')}
      description={t('infra.certificates.description')}
    >
      {read.isError && classifyFailure(read.error).kind === 'not_permitted' ? (
        <NotPermittedState
          what={t('infra.certificates.what')}
          permission="nodes.read"
          headingLevel={2}
        />
      ) : (
        <ReadableView
          readable={toReadable(read, {
            missing: (v) =>
              v.nodesTruncated ? [t('infra.certificates.nodesTruncated')] : undefined,
          })}
          what={t('infra.certificates.what')}
          onRetry={() => void read.refetch()}
          onRefresh={() => void read.refetch()}
          busy={read.isFetching}
          headingLevel={2}
          ready={(value) => <Certificates value={value} />}
        />
      )}
    </InfraPage>
  )
}

const ROLES = ['root_ca', 'issuing_ca', 'gateway_server_ca', 'postgres_ca'] as const
function roleLabel(role: string): string {
  const known = ROLES.find((r) => r === role)
  return known === undefined
    ? t('infra.certificates.role.other', { role })
    : t(`infra.certificates.role.${known}`)
}

const NOT_KNOWN = ['gateway_leaf', 'external_server_certificates'] as const
function notKnownText(subject: string): string {
  const known = NOT_KNOWN.find((s) => s === subject)
  return known === undefined
    ? t('infra.certificates.notKnown.other', { subject })
    : t(`infra.certificates.notKnown.${known}`)
}

function Certificates({ value }: { readonly value: NodeCertificates }): ReactNode {
  return (
    <div className="flex flex-col gap-10">
      <InfraSection id="certificate-authorities" title={t('infra.certificates.authorities.title')}>
        {value.authorities.length === 0 ? (
          <p className="text-sm text-foreground-light">
            {t('infra.certificates.authorities.none')}
          </p>
        ) : (
          <Table>
            <TableCaption className="sr-only">
              {t('infra.certificates.authorities.title')}
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t('infra.certificates.column.role')}</TableHead>
                <TableHead scope="col">{t('infra.certificates.column.subject')}</TableHead>
                <TableHead scope="col">{t('infra.certificates.column.validity')}</TableHead>
                <TableHead scope="col">{t('infra.certificates.column.fingerprint')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {value.authorities.map((authority) => (
                <TableRow key={authority.fingerprint} data-authority={authority.role}>
                  <TableCell>{roleLabel(authority.role)}</TableCell>
                  <TableCell>
                    <UntrustedName
                      name={authority.subjectCommonName}
                      mono
                      label={t('infra.certificates.column.subject')}
                    />
                  </TableCell>
                  <TableCell>
                    <Expiry notAfter={authority.notAfter} notBefore={authority.notBefore} />
                  </TableCell>
                  <TableCell>
                    <MarkedCode text={authority.fingerprint} className="text-xs" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {value.notRecorded.length === 0 ? null : (
          <ul
            className="flex flex-col gap-1 text-sm"
            aria-label={t('infra.certificates.notRecorded.title')}
          >
            {value.notRecorded.map((entry) => (
              <li key={entry.role} data-not-recorded={entry.role}>
                {t('infra.certificates.notRecorded.item', { role: roleLabel(entry.role) })}
              </li>
            ))}
          </ul>
        )}
      </InfraSection>
      <InfraSection
        id="certificate-nodes"
        title={t('infra.certificates.nodes.title')}
        description={t('infra.certificates.nodes.description')}
      >
        {value.nodes.length === 0 ? (
          <p className="text-sm text-foreground-light">{t('infra.certificates.nodes.none')}</p>
        ) : (
          <Table>
            <TableCaption className="sr-only">{t('infra.certificates.nodes.title')}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t('infra.column.id')}</TableHead>
                <TableHead scope="col">{t('infra.nodes.column.server')}</TableHead>
                <TableHead scope="col">{t('infra.nodes.column.state')}</TableHead>
                <TableHead scope="col">{t('infra.certificates.column.node')}</TableHead>
                <TableHead scope="col">{t('infra.certificates.column.server')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {value.nodes.map((node) => (
                <TableRow key={node.nodeId} data-node={node.nodeId}>
                  <TableCell>
                    <ObjectLink
                      href={nodePath(node.nodeId)}
                      text={node.nodeId}
                      label={t('infra.column.id')}
                    />
                  </TableCell>
                  <TableCell>
                    <ObjectLink
                      href={serverPath(node.serverId)}
                      text={node.serverId}
                      label={t('infra.nodes.column.server')}
                    />
                  </TableCell>
                  <TableCell>
                    <NodeStateBadge
                      state={node.state === 'pending_binding' ? 'pending_enrollment' : node.state}
                    />
                  </TableCell>
                  <TableCell>
                    <Expiry
                      notAfter={node.certificateExpiresAt}
                      warnMs={NODE_CERT_WARNING_HOURS * 3_600_000}
                    />
                  </TableCell>
                  <TableCell>
                    {node.serverCertificates.length === 0 ? (
                      t('infra.certificates.server.none')
                    ) : (
                      <ul className="flex flex-col gap-1">
                        {node.serverCertificates.map((certificate, index) => (
                          <li
                            // biome-ignore lint/suspicious/noArrayIndexKey: the agent's entries may repeat a name and never reorder
                            key={`${index}:${certificate.localName}`}
                            className="flex flex-wrap items-center gap-2"
                          >
                            <UntrustedName
                              name={certificate.localName}
                              mono
                              label={t('infra.node.clusters.local')}
                            />
                            <Expiry notAfter={certificate.expiresAt} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </InfraSection>
      <InfraSection id="certificate-unknown" title={t('infra.certificates.notKnown.title')}>
        {value.notKnown.length === 0 ? (
          <p className="text-sm text-foreground-light">{t('infra.certificates.notKnown.none')}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {value.notKnown.map((entry) => (
              <li key={entry.subject} data-not-known={entry.subject}>
                {notKnownText(entry.subject)}
              </li>
            ))}
          </ul>
        )}
      </InfraSection>
    </div>
  )
}
