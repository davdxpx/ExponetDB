import type { Cluster } from '@exponetdb/sdk/operations'
import { NotPermittedState, UntrustedName, UntrustedText } from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { useMe } from '../../lib/session/guard.tsx'
import { holds } from '../access/fields.tsx'
import { ReadSection } from '../target-ops/read-section.tsx'
import { CopyButton } from '../targets/copy.tsx'
import { phrase } from '../targets/phrase.ts'
import { bootstrapSqlQuery } from './keys.ts'

/**
 * The role bootstrap SQL of an external cluster
 * (`GET /clusters/{id}/bootstrap-sql`, `registry.manage`): read-only text a
 * person runs themselves with the provider's administrative tools, before the
 * cluster is confirmed. It creates ExponetDB's roles and contains no password
 * (each password is set with `psql \password` and submitted once, write-only).
 * The script is untrusted text, since it carries database names from the
 * registry: it is shown with every invisible and direction character marked,
 * and the page says to read it before running it. Nothing here executes SQL.
 */
export function BootstrapSql({ cluster }: { readonly cluster: Cluster }): ReactNode {
  const me = useMe()
  if (!holds(me, 'registry.manage')) {
    return (
      <NotPermittedState
        what={phrase('infra.bootstrap.notPermitted')}
        permission="registry.manage"
        headingLevel={3}
      />
    )
  }
  return <BootstrapSqlRead cluster={cluster} />
}

function BootstrapSqlRead({ cluster }: { readonly cluster: Cluster }): ReactNode {
  const { client } = useApi()
  const query = useQuery(bootstrapSqlQuery(client, cluster.id))
  return (
    <ReadSection
      query={query}
      what={t('infra.bootstrap.what')}
      permission="registry.manage"
      ready={(value) => (
        <div className="flex flex-col gap-4" data-bootstrap-sql>
          <div className="flex flex-col gap-1 text-sm">
            <p className="m-0 font-medium text-foreground">{t('infra.bootstrap.steps')}</p>
            <ol className="m-0 flex list-decimal flex-col gap-0.5 pl-5 text-foreground-light">
              <li>{t('infra.bootstrap.step.run')}</li>
              <li>{t('infra.bootstrap.step.password')}</li>
              <li>{t('infra.bootstrap.step.submit')}</li>
              {cluster.state === 'pending' ? <li>{t('infra.bootstrap.step.confirm')}</li> : null}
            </ol>
          </div>
          <dl className="m-0 flex flex-col gap-1 text-sm">
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-foreground-lighter">{t('infra.bootstrap.roles')}:</dt>
              <dd className="m-0 flex flex-wrap gap-x-2">
                {value.roles.map((role) => (
                  <UntrustedName key={role} name={role} mono label={t('infra.bootstrap.roles')} />
                ))}
              </dd>
            </div>
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-foreground-lighter">{t('infra.bootstrap.databases')}:</dt>
              <dd className="m-0 flex flex-wrap gap-x-2">
                {value.databases.length === 0 ? (
                  <span className="text-foreground-light">
                    {t('infra.bootstrap.databases.none')}
                  </span>
                ) : (
                  value.databases.map((database) => (
                    <UntrustedName
                      key={database}
                      name={database}
                      mono
                      label={t('infra.bootstrap.databases')}
                    />
                  ))
                )}
              </dd>
            </div>
          </dl>
          <figure className="m-0 overflow-hidden rounded-md border bg-surface-75">
            <figcaption className="flex items-center justify-between gap-2 border-b px-3 py-1 text-xs text-foreground-light">
              <span>
                {t('infra.bootstrap.script')}. {t('infra.bootstrap.noPassword')}
              </span>
              <CopyButton
                what={t('infra.bootstrap.copy')}
                label={t('infra.bootstrap.copy.label')}
                text={value.script}
              />
            </figcaption>
            <div className="max-h-96 overflow-auto p-3">
              <UntrustedText
                text={value.script}
                mono
                maxCodePoints={70_000}
                maxLines={2_000}
                label={t('infra.bootstrap.script')}
              />
            </div>
          </figure>
          <p className="m-0 text-xs text-foreground-light">{t('infra.bootstrap.check')}</p>
        </div>
      )}
    />
  )
}
