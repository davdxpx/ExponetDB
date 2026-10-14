import type {
  Cluster,
  DatabaseView,
  Environment,
  Product,
  Project,
} from '@exponetdb/sdk/operations'
import {
  Button,
  Card,
  CardContent,
  cn,
  Form,
  FormControl,
  FormField,
  inputVariants,
} from '@exponetdb/ui'
import {
  ConfirmDialog,
  FormItemLayout,
  PageContainer,
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
  ReadableView,
  TierChip,
  UntrustedName,
  useLinkComponent,
  useNavigate,
} from '@exponetdb/ui-patterns'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import * as z from 'zod'
import { useApi } from '../../lib/api/context.tsx'
import { withReauth } from '../../lib/api/reauth.ts'
import { t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { actionError } from '../plans/failure.ts'
import { planPath } from '../plans/plan-model.ts'
import {
  clusterDatabasesQuery,
  clustersQuery,
  environmentsQuery,
  productsQuery,
  projectsQuery,
} from './keys.ts'
import {
  credentialsPath,
  declaredTierOf,
  freeDatabases,
  registrationTier,
} from './register-model.ts'

interface Values {
  productId: string
  projectId: string
  environmentId: string
  clusterId: string
  databaseId: string
}

const EMPTY: Values = {
  productId: '',
  projectId: '',
  environmentId: '',
  clusterId: '',
  databaseId: '',
}

const SELECT = cn(inputVariants({ size: 'small' }), 'w-full max-w-md')

/**
 * Register a target (`/targets/register`): choose where the database belongs
 * (product, project, environment) and which database of which cluster, read
 * what will be created, confirm, and the server creates a registration plan
 * (`POST /targets`). The page then opens the plan for review: nothing changes
 * on a target until the plan is applied. The page decides nothing about
 * authority: it shows the cluster's declared tier and says that a database on
 * a cluster declared production (or not declared) needs production authority.
 */
export function RegisterTargetPage(): ReactNode {
  const { client, confirmIdentity } = useApi()
  const navigate = useNavigate()
  const Link = useLinkComponent()
  const schema = useMemo(() => {
    const required = t('register.choose')
    return z.object({
      productId: z.string().min(1, required),
      projectId: z.string().min(1, required),
      environmentId: z.string().min(1, required),
      clusterId: z.string().min(1, required),
      databaseId: z.string().min(1, required),
    })
  }, [])
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: EMPTY })
  const [confirming, setConfirming] = useState(false)
  const values = form.watch()

  const products = useQuery(productsQuery(client))
  const projects = useQuery(projectsQuery(client))
  const environments = useQuery(environmentsQuery(client, values.productId))
  const clusters = useQuery(clustersQuery(client))
  const databases = useQuery(clusterDatabasesQuery(client, values.clusterId))

  const product = products.data?.items.find((p) => p.id === values.productId)
  const project = projects.data?.items.find((p) => p.id === values.projectId)
  const environment = environments.data?.items.find((e) => e.id === values.environmentId)
  const cluster = clusters.data?.items.find((c) => c.id === values.clusterId)
  const database = databases.data?.items.find((d) => d.id === values.databaseId)
  const tier = registrationTier(environment?.tier, cluster)
  const complete =
    product !== undefined &&
    project !== undefined &&
    environment !== undefined &&
    cluster !== undefined &&
    database !== undefined

  const create = async (): Promise<void> => {
    if (!complete) return
    try {
      const plan = await withReauth(client, confirmIdentity, () =>
        client.operation('planTargetRegistration', {
          body: {
            projectId: project.id,
            environmentId: environment.id,
            databaseId: database.id,
          },
        }),
      )
      const path = planPath(plan.id)
      if (path === undefined) throw new Error('no plan')
      setConfirming(false)
      navigate(path)
    } catch (error) {
      throw actionError(error)
    }
  }

  return (
    <>
      <PageHeader size="large">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{t('register.title')}</PageHeaderTitle>
            <PageHeaderDescription>{t('register.description')}</PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="large" className="flex flex-col gap-6 py-6">
        <p>
          <Link href="/targets" className="text-sm underline focus-ring">
            {t('register.back')}
          </Link>
        </p>
        <Form {...form}>
          <form
            noValidate
            className="flex flex-col gap-6"
            onSubmit={form.handleSubmit(() => setConfirming(true))}
          >
            <Card>
              <CardContent className="flex flex-col gap-6 p-card">
                <h2 className="text-lg font-medium">{t('register.section.where')}</h2>
                <Choice
                  name="productId"
                  label={t('register.product')}
                  placeholder={t('register.product.placeholder')}
                  none={t('register.product.none')}
                  what={t('register.product')}
                  query={products}
                  options={(products.data?.items ?? []).map((p: Product) => ({
                    id: p.id,
                    label: p.displayName,
                  }))}
                  form={form}
                  partial={products.data?.more === true}
                  onChange={() => {
                    form.setValue('projectId', '')
                    form.setValue('environmentId', '')
                  }}
                />
                <Choice
                  name="projectId"
                  label={t('register.project')}
                  placeholder={t('register.project.placeholder')}
                  none={t('register.project.none')}
                  what={t('register.project')}
                  query={projects}
                  options={(projects.data?.items ?? [])
                    .filter((p: Project) => p.productId === values.productId)
                    .map((p) => ({ id: p.id, label: p.displayName }))}
                  form={form}
                  partial={projects.data?.more === true}
                  disabled={values.productId === ''}
                />
                <Choice
                  name="environmentId"
                  label={t('register.environment')}
                  placeholder={t('register.environment.placeholder')}
                  none={t('register.environment.none')}
                  what={t('register.environment')}
                  query={environments}
                  options={(environments.data?.items ?? []).map((e: Environment) => ({
                    id: e.id,
                    label: e.displayName,
                  }))}
                  form={form}
                  partial={environments.data?.more === true}
                  disabled={values.productId === ''}
                  hint={
                    environment === undefined
                      ? undefined
                      : t('register.environment.tier', {
                          tier: environment.tier === 'prod' ? 'production' : 'non-production',
                        })
                  }
                />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex flex-col gap-6 p-card">
                <h2 className="text-lg font-medium">{t('register.section.database')}</h2>
                <Choice
                  name="clusterId"
                  label={t('register.cluster')}
                  placeholder={t('register.cluster.placeholder')}
                  none={t('register.cluster.none')}
                  what={t('register.cluster')}
                  query={clusters}
                  options={(clusters.data?.items ?? []).map((c: Cluster) => ({
                    id: c.id,
                    label: c.displayName,
                  }))}
                  form={form}
                  partial={clusters.data?.more === true}
                  onChange={() => form.setValue('databaseId', '')}
                />
                {cluster === undefined ? null : <ClusterTier cluster={cluster} />}
                <Choice
                  name="databaseId"
                  label={t('register.database')}
                  placeholder={t('register.database.placeholder')}
                  none={t('register.database.none')}
                  what={t('register.database')}
                  query={databases}
                  options={freeDatabases(databases.data?.items ?? []).map((d: DatabaseView) => ({
                    id: d.id,
                    label: d.name,
                  }))}
                  form={form}
                  disabled={values.clusterId === ''}
                  partial={databases.data?.truncated === true}
                />
                <p className="text-sm text-foreground-light">{t('register.authority')}</p>
              </CardContent>
            </Card>
            <Card data-tier={tier}>
              <CardContent className="flex flex-col gap-3 p-card">
                <h2 className="text-lg font-medium">{t('register.summary.title')}</h2>
                {complete ? (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                    <dt className="text-foreground-light">{t('register.summary.target')}</dt>
                    <dd className="flex flex-wrap items-center gap-2">
                      <UntrustedName name={product.slug} mono label="product" />
                      <span aria-hidden="true">/</span>
                      <UntrustedName name={project.slug} mono label="project" />
                      <span aria-hidden="true">/</span>
                      <UntrustedName name={environment.slug} mono label="environment" />
                      <TierChip tier={tier} />
                    </dd>
                    <dt className="text-foreground-light">{t('register.cluster')}</dt>
                    <dd>
                      <UntrustedName name={cluster.displayName} label="cluster" />
                    </dd>
                    <dt className="text-foreground-light">{t('register.database')}</dt>
                    <dd>
                      <UntrustedName name={database.name} mono label="database" />
                    </dd>
                  </dl>
                ) : (
                  <p className="text-sm text-foreground-light">
                    {t('register.summary.incomplete')}
                  </p>
                )}
                <div>
                  <Button type="submit" variant="primary" size="small">
                    {t('register.submit')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </form>
        </Form>
        <ConfirmDialog
          open={confirming && complete}
          onOpenChange={setConfirming}
          title={t('register.confirm.title')}
          description={t('register.confirm.body')}
          actionLabel={t('register.confirm.action')}
          cancelLabel={t('register.confirm.cancel')}
          tier={tier}
          onConfirm={create}
        />
      </PageContainer>
    </>
  )
}

function ClusterTier({ cluster }: { readonly cluster: Cluster }): ReactNode {
  const Link = useLinkComponent()
  const declared = declaredTierOf(cluster)
  const credentials = credentialsPath(cluster.id)
  return (
    <div data-declared={declared} className="flex flex-col gap-1 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        {declared === 'undeclared' ? (
          <span>{t('register.cluster.undeclared')}</span>
        ) : (
          <>
            <TierChip tier={declared} />
            <span>
              {t('register.cluster.declared', {
                tier: declared === 'prod' ? 'production' : 'non-production',
              })}
            </span>
          </>
        )}
      </p>
      <p>
        <Link href="/infrastructure/clusters" className="underline focus-ring">
          {t('register.cluster.declare')}
        </Link>
        {credentials === undefined ? null : (
          <>
            {' · '}
            <Link href={credentials} className="underline focus-ring">
              {t('register.hint.credentialsLink')}
            </Link>
          </>
        )}
      </p>
    </div>
  )
}

interface Option {
  readonly id: string
  readonly label: string
}

/** One choice: a select that exists only once its list was read; a failed read says so and offers a retry. */
function Choice(props: {
  readonly name: keyof Values
  readonly label: string
  readonly placeholder: string
  readonly none: string
  readonly what: string
  readonly query: {
    readonly data: unknown
    readonly error: unknown
    readonly isError: boolean
    readonly dataUpdatedAt: number
    readonly isFetching: boolean
    readonly refetch: () => unknown
  }
  readonly options: readonly Option[]
  readonly form: ReturnType<typeof useForm<Values>>
  readonly disabled?: boolean
  readonly hint?: string | undefined
  readonly onChange?: () => void
  readonly partial?: boolean
}): ReactNode {
  const { query } = props
  const select = (disabled: boolean): ReactNode => (
    <FormField
      control={props.form.control}
      name={props.name}
      render={({ field }) => (
        <FormItemLayout layout="horizontal" label={props.label} description={props.hint}>
          <FormControl>
            <select
              {...field}
              className={SELECT}
              disabled={disabled}
              onChange={(event) => {
                field.onChange(event)
                props.onChange?.()
              }}
            >
              <option value="">{props.placeholder}</option>
              {props.options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </FormControl>
        </FormItemLayout>
      )}
    />
  )
  // Its parent choice is empty: the query has not started, so there is nothing to say yet.
  if (props.disabled === true) return select(true)
  const readable = toReadable(query as Parameters<typeof toReadable>[0], {
    staleAfterMs: Number.POSITIVE_INFINITY,
    missing: () =>
      props.partial === true ? [t('register.choices.more', { what: props.what })] : undefined,
  })
  return (
    <ReadableView
      readable={readable}
      what={props.what}
      onRetry={() => void query.refetch()}
      onRefresh={() => void query.refetch()}
      busy={query.isFetching}
      headingLevel={3}
      empty={{
        isEmpty: () => props.options.length === 0,
        content: <p className="text-sm text-foreground-light">{props.none}</p>,
      }}
      ready={() => select(false)}
    />
  )
}
