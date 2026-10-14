import { Button, Input } from '@exponetdb/ui'
import { TierChip, UntrustedName } from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { usePlanAction } from '../../lib/api/plan-action.ts'
import { t } from '../../lib/i18n/i18n.ts'
import { toReadable } from '../../lib/query/readable.ts'
import { useMe } from '../../lib/session/guard.tsx'
import { Field, holds, NativeSelect } from '../access/fields.tsx'
import { ListView } from '../access/list-view.tsx'
import { type StatusLine, StatusLines, useStatusLine } from '../access/status.tsx'
import {
  byRank,
  changeOf,
  draftOf,
  type EnvironmentDraft,
  evidenceChains,
  validRank,
} from './environment-model.ts'
import {
  type Environment,
  environmentsQuery,
  type Product,
  productsQuery,
  SETTINGS_PAGE_LIMIT,
} from './keys.ts'
import { DISPLAY_NAME, SLUG } from './products-page.tsx'
import { SettingsFrame } from './settings-frame.tsx'

/**
 * `/settings/environments`: the environments of each product with their tier
 * (taken from the contract, never from a slug), their order and the evidence
 * chain a production change follows. A change of tier, evidence, order or
 * name, and a new environment, are plans (`registry.manage`); the review page
 * opens. A production environment carries the production chip.
 */
export function EnvironmentsPage(): ReactNode {
  const { client } = useApi()
  const me = useMe()
  const canManage = holds(me, 'registry.manage')
  const line = useStatusLine()
  const products = useQuery(productsQuery(client))
  const readable = toReadable(products, {
    missing: (page) =>
      page.nextCursor === null
        ? undefined
        : [t('settings.products.more', { count: SETTINGS_PAGE_LIMIT })],
  })
  return (
    <SettingsFrame
      title={t('settings.environments.title')}
      description={t('settings.environments.description')}
    >
      <StatusLines line={line} />
      {canManage ? null : (
        <p className="text-sm text-foreground-light">{t('settings.registry.missing')}</p>
      )}
      <ListView
        readable={readable}
        error={products.error}
        what={t('settings.products.what')}
        permission="targets.read"
        isEmpty={(page) => page.items.length === 0}
        emptyTitle={t('settings.products.empty.title')}
        emptyDescription={t('settings.products.empty.body')}
        onRetry={() => void products.refetch()}
        busy={products.isFetching}
      >
        {(page) => (
          <div className="flex flex-col gap-8">
            {page.items.map((product) => (
              <ProductEnvironments
                key={product.id}
                product={product}
                line={line}
                canManage={canManage}
              />
            ))}
          </div>
        )}
      </ListView>
    </SettingsFrame>
  )
}

function ProductEnvironments({
  product,
  line,
  canManage,
}: {
  readonly product: Product
  readonly line: StatusLine
  readonly canManage: boolean
}): ReactNode {
  const { client } = useApi()
  const environments = useQuery(environmentsQuery(client, product.id))
  const id = useId()
  const readable = toReadable(environments, {
    missing: (page) =>
      page.nextCursor === null
        ? undefined
        : [t('settings.environments.more', { count: SETTINGS_PAGE_LIMIT })],
  })
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-3"
      data-product={product.id}
    >
      <h2 id={`${id}-title`} className="text-base font-medium text-foreground">
        <UntrustedName name={product.displayName} label={t('settings.products.column.name')} />{' '}
        <code className="font-mono text-xs text-foreground-light">{product.slug}</code>
      </h2>
      <ListView
        readable={readable}
        error={environments.error}
        what={t('settings.environments.what')}
        permission="targets.read"
        isEmpty={(page) => page.items.length === 0}
        emptyTitle={t('settings.environments.empty.title')}
        emptyDescription={t('settings.environments.empty.body')}
        onRetry={() => void environments.refetch()}
        busy={environments.isFetching}
      >
        {(page) => (
          <div className="flex flex-col gap-3">
            <Chains environments={page.items} />
            {page.items.length === 0 ? null : (
              <ul className="environment-list flex flex-col gap-2">
                {byRank(page.items).map((environment) => (
                  <EnvironmentRow
                    key={environment.id}
                    product={product}
                    environment={environment}
                    siblings={page.items}
                    line={line}
                    canManage={canManage}
                  />
                ))}
              </ul>
            )}
            {canManage ? (
              <EnvironmentForm product={product} siblings={page.items} line={line} />
            ) : null}
          </div>
        )}
      </ListView>
    </section>
  )
}

function Chains({ environments }: { readonly environments: readonly Environment[] }): ReactNode {
  const chains = evidenceChains(environments)
  if (chains.length === 0) {
    return <p className="text-sm text-foreground-light">{t('settings.environments.chain.none')}</p>
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm text-foreground">{t('settings.environments.chain')}</p>
      <ul className="flex flex-col gap-0.5">
        {chains.map((chain) => (
          <li key={chain.join('>')} className="font-mono text-xs text-foreground-light">
            {chain.join(' → ')}
          </li>
        ))}
      </ul>
    </div>
  )
}

function EnvironmentRow({
  product,
  environment,
  siblings,
  line,
  canManage,
}: {
  readonly product: Product
  readonly environment: Environment
  readonly siblings: readonly Environment[]
  readonly line: StatusLine
  readonly canManage: boolean
}): ReactNode {
  const [editing, setEditing] = useState(false)
  const formId = useId()
  return (
    <li
      className="flex flex-col gap-2 rounded-md border border-default p-3"
      data-environment={environment.id}
      data-tier={environment.tier}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="font-medium text-foreground">
          <UntrustedName name={environment.displayName} label={t('settings.displayName')} />
        </span>
        <code className="font-mono text-xs text-foreground-light">{environment.slug}</code>
        <TierChip tier={environment.tier} />
        <span className="text-foreground-light">
          {environment.evidenceFrom === null
            ? t('settings.environments.evidence.none')
            : t('settings.environments.evidence.from', { slug: environment.evidenceFrom })}
        </span>
        <span className="text-foreground-lighter">
          {t('settings.environments.rank', { rank: environment.rank })}
        </span>
        <span className="text-foreground-lighter">
          {t('settings.environments.revision', { revision: environment.revision })}
        </span>
        {canManage ? (
          <Button
            type="button"
            variant="text"
            size="tiny"
            aria-expanded={editing}
            aria-controls={formId}
            onClick={() => setEditing((value) => !value)}
          >
            {editing ? t('settings.environments.edit.hide') : t('settings.environments.edit')}
          </Button>
        ) : null}
      </div>
      <div id={formId} hidden={!editing}>
        {editing ? (
          <EnvironmentForm
            product={product}
            siblings={siblings}
            line={line}
            environment={environment}
          />
        ) : null}
      </div>
    </li>
  )
}

const EMPTY: EnvironmentDraft = { displayName: '', tier: 'nonprod', evidenceFrom: '', rank: '' }

/** A new environment (without `environment`) or a change of one, as a plan. */
function EnvironmentForm({
  product,
  siblings,
  line,
  environment,
}: {
  readonly product: Product
  readonly siblings: readonly Environment[]
  readonly line: StatusLine
  readonly environment?: Environment
}): ReactNode {
  const { client } = useApi()
  const createPlan = usePlanAction()
  const id = useId()
  const [slug, setSlug] = useState('')
  const [draft, setDraft] = useState<EnvironmentDraft>(
    environment === undefined ? EMPTY : draftOf(environment),
  )
  const [errors, setErrors] = useState<Partial<Record<'slug' | 'name' | 'rank' | 'form', string>>>(
    {},
  )
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const evidenceOptions = [
    { value: '', label: t('settings.environments.evidence.noneOption') },
    ...byRank(siblings)
      .filter((sibling) => sibling.id !== environment?.id)
      .map((sibling) => ({ value: sibling.slug, label: sibling.slug })),
  ]

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const next: Partial<Record<'slug' | 'name' | 'rank' | 'form', string>> = {}
    if (environment === undefined && !SLUG.test(slug.trim())) next.slug = t('settings.slug.invalid')
    if (!DISPLAY_NAME.test(draft.displayName.trim())) next.name = t('settings.displayName.invalid')
    if (draft.rank.trim() !== '' && !validRank(draft.rank)) next.rank = t('settings.rank.invalid')
    if (environment !== undefined && draft.rank.trim() === '')
      next.rank = t('settings.rank.invalid')
    const change = environment === undefined ? undefined : changeOf(environment, draft)
    if (
      change !== undefined &&
      Object.keys(change).length === 0 &&
      Object.keys(next).length === 0
    ) {
      next.form = t('settings.environments.edit.noChange')
    }
    setErrors(next)
    if (Object.keys(next).length > 0 || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    line.clear()
    try {
      if (environment === undefined || change === undefined) {
        const rank = draft.rank.trim()
        await createPlan(() =>
          client.operation('planEnvironment', {
            params: { productId: product.id },
            body: {
              slug: slug.trim(),
              displayName: draft.displayName.trim(),
              tier: draft.tier,
              evidenceFrom: draft.evidenceFrom === '' ? null : draft.evidenceFrom,
              ...(rank === '' ? {} : { rank: Number(rank) }),
            },
          }),
        )
      } else {
        await createPlan(() =>
          client.operation('planEnvironmentChange', {
            params: { productId: product.id, environmentId: environment.id },
            body: change,
          }),
        )
      }
    } catch (error) {
      line.fail(error)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <form
      className="environment-form flex flex-col gap-3"
      noValidate
      onSubmit={submit}
      aria-label={
        environment === undefined
          ? t('settings.environments.create.title')
          : t('settings.environments.edit.form', { slug: environment.slug })
      }
    >
      {environment === undefined ? (
        <h3 className="text-sm font-medium text-foreground">
          {t('settings.environments.create.title')}
        </h3>
      ) : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {environment === undefined ? (
          <Field
            id={`${id}-slug`}
            label={t('settings.slug')}
            description={t('settings.slug.hint')}
            error={errors.slug}
          >
            <Input
              id={`${id}-slug`}
              autoComplete="off"
              spellCheck={false}
              maxLength={39}
              className="font-mono"
              value={slug}
              aria-invalid={errors.slug !== undefined}
              aria-describedby={`${id}-slug-description`}
              onChange={(event) => setSlug(event.target.value)}
            />
          </Field>
        ) : null}
        <Field id={`${id}-name`} label={t('settings.displayName')} error={errors.name}>
          <Input
            id={`${id}-name`}
            autoComplete="off"
            maxLength={120}
            value={draft.displayName}
            aria-invalid={errors.name !== undefined}
            onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
          />
        </Field>
        <Field
          id={`${id}-tier`}
          label={t('settings.environments.tier')}
          description={t('settings.environments.tier.hint')}
        >
          <NativeSelect
            id={`${id}-tier`}
            value={draft.tier}
            aria-describedby={`${id}-tier-description`}
            options={[
              { value: 'nonprod', label: t('settings.tier.nonprod') },
              { value: 'prod', label: t('settings.tier.prod') },
            ]}
            onChange={(event) =>
              setDraft({ ...draft, tier: event.target.value === 'prod' ? 'prod' : 'nonprod' })
            }
          />
        </Field>
        <Field id={`${id}-evidence`} label={t('settings.environments.evidence')}>
          <NativeSelect
            id={`${id}-evidence`}
            value={draft.evidenceFrom}
            options={evidenceOptions}
            onChange={(event) => setDraft({ ...draft, evidenceFrom: event.target.value })}
          />
        </Field>
        <Field
          id={`${id}-rank`}
          label={t('settings.environments.rankLabel')}
          description={t('settings.rank.hint')}
          error={errors.rank}
        >
          <Input
            id={`${id}-rank`}
            inputMode="numeric"
            autoComplete="off"
            maxLength={4}
            value={draft.rank}
            aria-invalid={errors.rank !== undefined}
            aria-describedby={`${id}-rank-description`}
            onChange={(event) => setDraft({ ...draft, rank: event.target.value })}
          />
        </Field>
      </div>
      {draft.tier === 'prod' && environment?.tier !== 'prod' ? (
        <p className="text-sm text-foreground-light">{t('settings.environments.tier.prodNote')}</p>
      ) : null}
      {errors.form === undefined ? null : (
        <p className="text-sm text-destructive" role="alert">
          {errors.form}
        </p>
      )}
      <div>
        <Button type="submit" variant="default" size="small" loading={busy}>
          {environment === undefined
            ? t('settings.environments.create.submit')
            : t('settings.environments.edit.submit')}
        </Button>
      </div>
    </form>
  )
}
