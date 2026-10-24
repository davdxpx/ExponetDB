import type { CredentialView } from '@exponetdb/sdk/operations'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exponetdb/ui'
import {
  Admonition,
  KeyValueList,
  ObservedTime,
  TierChip,
  UntrustedName,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { nounPhrase } from '../target/phrases.ts'
import type { Target } from '../target/queries.ts'
import { clusterPath } from '../target-ops/ids.ts'
import { clusterCredentialsQuery, policySettingsQuery } from '../target-ops/keys.ts'
import { ReadSection } from '../target-ops/read-section.tsx'
import { Section } from '../target-ops/section.tsx'
import { TargetPage } from '../target-ops/target-page.tsx'
import { CopyButton } from '../targets/copy.tsx'
import { ConnectSection } from './connect-section.tsx'
import { type DataReadModel, dataReadOf } from './data-read.ts'
import { LifecycleSection } from './lifecycle-section.tsx'

const MODE_LABELS: Readonly<Record<DataReadModel['mode'], MessageKey>> = {
  by_tier: 'configuration.dataRead.mode.by_tier',
  enabled: 'configuration.dataRead.mode.enabled',
  humans_only: 'configuration.dataRead.mode.humans_only',
  disabled: 'configuration.dataRead.mode.disabled',
  unreadable: 'configuration.dataRead.mode.unreadable',
}

const FROM_LABELS: Readonly<Record<DataReadModel['from'], MessageKey>> = {
  target: 'configuration.dataRead.from.target',
  environment: 'configuration.dataRead.from.environment',
  project: 'configuration.dataRead.from.project',
  product: 'configuration.dataRead.from.product',
  installation: 'configuration.dataRead.from.installation',
  default: 'configuration.dataRead.from.default',
}

/**
 * `/t/<product>/<project>/<environment>/configuration`: how the target is
 * set up. What the Control Store registry says about it, where applications
 * connect (for people who may see endpoint addresses), the data-read policy
 * that applies to it, the PostgreSQL settings (a named state: the Control
 * Plane has no read of them), the roles of its cluster and the target's
 * lifecycle. Nothing changes here directly: the lifecycle actions and the
 * settings on their own pages are plans that open for review.
 */
export function ConfigurationPage(): ReactNode {
  return (
    <TargetPage section="configuration" description={t('configuration.description')}>
      {(target) => (
        <>
          <TargetFacts target={target} />
          <ConnectSection target={target} />
          <DataReadPolicy target={target} />
          <PostgresSettings />
          <ClusterRoles target={target} />
          <LifecycleSection target={target} />
        </>
      )}
    </TargetPage>
  )
}

function TargetFacts({ target }: { readonly target: Target }): ReactNode {
  const Link = useLinkComponent()
  const cluster = target.placement === null ? undefined : clusterPath(target.placement.clusterId)
  return (
    <Section
      id="target"
      title={t('configuration.target.title')}
      description={t('configuration.target.description')}
    >
      <KeyValueList
        items={[
          {
            id: 'path',
            label: t('configuration.target.path'),
            value: (
              <span className="inline-flex flex-wrap items-baseline gap-x-2">
                <UntrustedName name={target.path} mono label={t('configuration.target.path')} />
                <CopyButton
                  what={t('configuration.copy.path')}
                  label={t('configuration.copy.path.label')}
                  text={target.path}
                />
              </span>
            ),
          },
          {
            id: 'id',
            label: t('configuration.target.id'),
            value: (
              <span className="inline-flex flex-wrap items-baseline gap-x-2">
                <UntrustedName name={target.id} mono label={t('configuration.target.id')} />
                <CopyButton
                  what={t('configuration.copy.id')}
                  label={t('configuration.copy.id.label')}
                  text={target.id}
                />
              </span>
            ),
          },
          {
            id: 'tier',
            label: t('configuration.target.tier'),
            value: <TierChip tier={target.tier} name={target.environment.slug} />,
          },
          { id: 'state', label: t('configuration.target.state'), value: target.state },
          {
            id: 'generation',
            label: t('configuration.target.generation'),
            value: String(target.generation),
          },
          {
            id: 'placement',
            label: t('configuration.target.placement'),
            value:
              target.placement === null ? (
                t('configuration.target.noPlacement')
              ) : (
                <>
                  <UntrustedName
                    name={target.placement.clusterName}
                    label={t('configuration.target.placement')}
                  />{' '}
                  <span className="text-foreground-light">
                    {t('configuration.target.mode', { mode: target.placement.managementMode })}
                  </span>{' '}
                  {target.placement.postgresVersion === null ? null : (
                    <UntrustedName
                      name={`PostgreSQL ${target.placement.postgresVersion}`}
                      label={t('configuration.target.version')}
                    />
                  )}{' '}
                  {cluster === undefined ? null : (
                    <Link href={cluster} className="text-primary underline focus-ring">
                      {t('configuration.target.openCluster')}
                    </Link>
                  )}
                </>
              ),
          },
        ]}
      />
    </Section>
  )
}

function DataReadPolicy({ target }: { readonly target: Target }): ReactNode {
  const { client } = useApi()
  const Link = useLinkComponent()
  const query = useQuery(policySettingsQuery(client))
  return (
    <Section
      id="data-read"
      title={t('configuration.dataRead.title')}
      description={t('configuration.dataRead.description')}
    >
      <ReadSection
        query={query}
        what={nounPhrase('configuration.dataRead.what')}
        permission="access.read"
        ready={(settings) => {
          const model = dataReadOf(settings, {
            target: target.id,
            environment: target.environmentId,
            project: target.projectId,
            product: target.productId,
          })
          if (model === undefined) {
            return <p className="m-0 text-sm">{t('configuration.dataRead.notListed')}</p>
          }
          return (
            <div className="flex flex-col gap-2" data-data-read={model.mode}>
              <KeyValueList
                items={[
                  {
                    id: 'mode',
                    label: t('configuration.dataRead.mode'),
                    value: t(MODE_LABELS[model.mode]),
                  },
                  {
                    id: 'from',
                    label: t('configuration.dataRead.from'),
                    value:
                      model.revision === null
                        ? t(FROM_LABELS[model.from])
                        : t('configuration.dataRead.fromRevision', {
                            from: t(FROM_LABELS[model.from]),
                            revision: model.revision,
                          }),
                  },
                  {
                    id: 'columns',
                    label: t('configuration.dataRead.columns'),
                    value:
                      model.sensitiveColumns.length === 0 ? (
                        t('configuration.dataRead.noColumns')
                      ) : (
                        <span className="flex flex-wrap gap-x-2">
                          {model.sensitiveColumns.map((pattern) => (
                            <UntrustedName
                              key={pattern}
                              name={pattern}
                              mono
                              label={t('configuration.dataRead.columns')}
                            />
                          ))}
                        </span>
                      ),
                  },
                ]}
              />
              <p className="m-0 text-xs text-foreground-light">
                {t('configuration.dataRead.note')}{' '}
                <Link href="/settings/policies" className="text-primary underline focus-ring">
                  {t('configuration.dataRead.change')}
                </Link>
              </p>
            </div>
          )
        }}
      />
    </Section>
  )
}

function PostgresSettings(): ReactNode {
  return (
    <Section
      id="postgres"
      title={t('configuration.postgres.title')}
      description={t('configuration.postgres.description')}
    >
      <Admonition
        type="info"
        title={t('configuration.postgres.unavailable.title')}
        description={t('configuration.postgres.unavailable.body')}
      />
    </Section>
  )
}

function ClusterRoles({ target }: { readonly target: Target }): ReactNode {
  const placement = target.placement
  const Link = useLinkComponent()
  return (
    <Section
      id="roles"
      title={t('configuration.roles.title')}
      description={t('configuration.roles.description')}
    >
      {placement === null ? (
        <p className="m-0 text-sm text-foreground-light">{t('configuration.roles.noCluster')}</p>
      ) : (
        <CredentialRows clusterId={placement.clusterId} />
      )}
      <p className="m-0 text-sm">
        <Link href="/infrastructure/clusters" className="text-primary underline focus-ring">
          {t('configuration.roles.manage')}
        </Link>
      </p>
    </Section>
  )
}

function CredentialRows({ clusterId }: { readonly clusterId: string }): ReactNode {
  const { client } = useApi()
  const query = useQuery(clusterCredentialsQuery(client, clusterId))
  return (
    <ReadSection
      query={query}
      what={nounPhrase('configuration.roles.what')}
      permission="registry.manage"
      missing={(value) => (value.truncated ? [t('configuration.roles.more')] : undefined)}
      empty={{ isEmpty: (value) => value.items.length === 0 }}
      ready={(value) => <CredentialTable credentials={value.items} />}
    />
  )
}

function CredentialTable({
  credentials,
}: {
  readonly credentials: readonly CredentialView[]
}): ReactNode {
  return (
    <Table>
      <TableCaption className="sr-only">{t('configuration.roles.caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t('configuration.roles.column.role')}</TableHead>
          <TableHead scope="col">{t('configuration.roles.column.access')}</TableHead>
          <TableHead scope="col">{t('configuration.roles.column.state')}</TableHead>
          <TableHead scope="col">{t('configuration.roles.column.verified')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {credentials.map((credential) => (
          <TableRow key={credential.id} data-credential={credential.id}>
            <TableCell>
              <UntrustedName
                name={credential.roleName}
                mono
                label={t('configuration.roles.column.role')}
              />
            </TableCell>
            <TableCell>{credential.accessRole}</TableCell>
            <TableCell>
              {credential.state}
              {credential.failureCode === null ? null : (
                <div className="font-mono text-xs text-foreground-light">
                  {credential.failureCode}
                </div>
              )}
            </TableCell>
            <TableCell>
              {credential.verifiedAt === null ? (
                t('configuration.roles.notVerified')
              ) : (
                <ObservedTime observedAt={credential.verifiedAt} withDate />
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
