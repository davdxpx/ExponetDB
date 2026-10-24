import { TierChip } from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { t } from '../../lib/i18n/i18n.ts'
import { inlineName } from '../consent/inline-name.ts'
import { ChoiceSelect } from './choice-select.tsx'
import { tierLabel } from './model.ts'
import { type ScopeKind, toBindingScope } from './people-model.ts'
import {
  type EnvironmentChoice,
  environmentChoicesQuery,
  productChoicesQuery,
  projectChoicesQuery,
  targetChoicesQuery,
} from './scope-reads.ts'

/**
 * The scope of a role binding chosen by name (`binding-form.tsx`): a product,
 * a project, an environment of a product or a target, each from the read that
 * lists it, with a line that says whether the scope covers production. The
 * choice only fills the typed ID, which stays the value the plan is made
 * from and is checked as before; a read that fails or is cut leaves the
 * field to type in. The coverage is derived from the registry's own tiers
 * (a target's, an environment's, the environments of a product) and is
 * stated as unknown when it cannot be derived, never as non-production.
 */
export type Coverage = 'production' | 'nonproduction' | 'unknown'

export function CoverageNote({
  coverage,
  hasId,
}: {
  readonly coverage: Coverage
  /** Whether an ID is entered at all; without one there is nothing to say. */
  readonly hasId: boolean
}): ReactNode {
  if (!hasId && coverage === 'unknown') return null
  return (
    <p
      className="flex flex-wrap items-center gap-2 text-xs text-foreground-light"
      data-coverage={coverage}
    >
      {coverage === 'unknown' ? null : (
        <TierChip tier={coverage === 'production' ? 'prod' : 'nonprod'} />
      )}
      <span>
        {coverage === 'production'
          ? t('scope.coverage.production')
          : coverage === 'nonproduction'
            ? t('scope.coverage.nonprod')
            : t('scope.coverage.unknown')}
      </span>
    </p>
  )
}

/** Any production environment among a product's environments (an unlisted rest stays unknown). */
function coverageOfEnvironments(
  environments: readonly EnvironmentChoice[],
  complete: boolean,
): Coverage {
  if (environments.some((environment) => environment.tier === 'prod')) return 'production'
  return complete ? 'nonproduction' : 'unknown'
}

/** What the environments of a product say about whether a scope within it covers production. */
function useProductCoverage(productId: string | undefined): Coverage {
  const { client } = useApi()
  const environments = useQuery({
    ...environmentChoicesQuery(client, productId ?? ''),
    enabled: productId !== undefined,
  })
  const page = environments.data
  if (productId === undefined || page === undefined) return 'unknown'
  return coverageOfEnvironments(page.items, page.nextCursor === null)
}

export interface ScopePickerProps {
  readonly kind: Exclude<ScopeKind, 'global'>
  /** The ID typed or chosen. */
  readonly value: string
  readonly onChange: (id: string) => void
  /** A prefix that keeps the ids of the controls unique on a page with several forms. */
  readonly idBase: string
}

export function ScopePicker({ kind, value, onChange, idBase }: ScopePickerProps): ReactNode {
  switch (kind) {
    case 'product':
      return <ProductScope value={value} onChange={onChange} idBase={idBase} />
    case 'project':
      return <ProjectScope value={value} onChange={onChange} idBase={idBase} />
    case 'environment':
      return <EnvironmentScope value={value} onChange={onChange} idBase={idBase} />
    case 'target':
      return <TargetScope value={value} onChange={onChange} idBase={idBase} />
  }
}

type PickerProps = Omit<ScopePickerProps, 'kind'>

function ProductScope({ value, onChange, idBase }: PickerProps): ReactNode {
  const { client } = useApi()
  const products = useQuery(productChoicesQuery(client))
  const id = value.trim()
  const chosen = products.data?.items.find((product) => product.id === id)
  const coverage = useProductCoverage(chosen?.id)
  return (
    <div className="flex flex-col gap-2">
      <ChoiceSelect
        id={`${idBase}-product`}
        label={t('scope.pick.product')}
        what={t('choice.what.products')}
        permission="targets.read"
        query={products}
        choices={(page) =>
          page.items.map((product) => ({
            value: product.id,
            label: `${inlineName(product.displayName) ?? product.slug} (${product.slug})`,
          }))
        }
        placeholder={t('scope.pick.product.placeholder')}
        value={id}
        onChange={onChange}
      />
      <CoverageNote coverage={coverage} hasId={toBindingScope('product', id) !== undefined} />
    </div>
  )
}

function ProjectScope({ value, onChange, idBase }: PickerProps): ReactNode {
  const { client } = useApi()
  const projects = useQuery(projectChoicesQuery(client))
  const id = value.trim()
  const chosen = projects.data?.items.find((project) => project.id === id)
  const coverage = useProductCoverage(chosen?.productId)
  return (
    <div className="flex flex-col gap-2">
      <ChoiceSelect
        id={`${idBase}-project`}
        label={t('scope.pick.project')}
        what={t('choice.what.projects')}
        permission="targets.read"
        query={projects}
        choices={(page) =>
          page.items.map((project) => ({
            value: project.id,
            label: inlineName(project.path) ?? project.slug,
          }))
        }
        placeholder={t('scope.pick.project.placeholder')}
        value={id}
        onChange={onChange}
      />
      <CoverageNote coverage={coverage} hasId={toBindingScope('project', id) !== undefined} />
    </div>
  )
}

function EnvironmentScope({ value, onChange, idBase }: PickerProps): ReactNode {
  const { client } = useApi()
  const products = useQuery(productChoicesQuery(client))
  const [productId, setProductId] = useState('')
  const environments = useQuery({
    ...environmentChoicesQuery(client, productId),
    enabled: productId !== '',
  })
  const id = value.trim()
  const chosen = environments.data?.items.find((environment) => environment.id === id)
  const coverage: Coverage =
    chosen === undefined ? 'unknown' : chosen.tier === 'prod' ? 'production' : 'nonproduction'
  return (
    <div className="flex flex-col gap-3">
      <ChoiceSelect
        id={`${idBase}-environment-product`}
        label={t('scope.pick.environment.product')}
        what={t('choice.what.products')}
        permission="targets.read"
        query={products}
        choices={(page) =>
          page.items.map((product) => ({
            value: product.id,
            label: `${inlineName(product.displayName) ?? product.slug} (${product.slug})`,
          }))
        }
        placeholder={t('scope.pick.product.placeholder')}
        value={productId}
        onChange={(next) => {
          setProductId(next)
          onChange('')
        }}
      />
      {productId === '' ? (
        <p className="text-xs text-foreground-lighter">
          {t('scope.pick.environment.needsProduct')}
        </p>
      ) : (
        <ChoiceSelect
          id={`${idBase}-environment`}
          label={t('scope.pick.environment')}
          what={t('choice.what.environments')}
          permission="targets.read"
          query={environments}
          choices={(page) =>
            page.items.map((environment) => ({
              value: environment.id,
              label: `${inlineName(environment.displayName) ?? environment.slug} (${environment.slug}, ${tierLabel(environment.tier)})`,
            }))
          }
          placeholder={t('scope.pick.environment.placeholder')}
          value={id}
          onChange={onChange}
        />
      )}
      <CoverageNote coverage={coverage} hasId={toBindingScope('environment', id) !== undefined} />
    </div>
  )
}

function TargetScope({ value, onChange, idBase }: PickerProps): ReactNode {
  const { client } = useApi()
  const targets = useQuery(targetChoicesQuery(client))
  const id = value.trim()
  const chosen = targets.data?.items.find((target) => target.id === id)
  const coverage: Coverage =
    chosen === undefined ? 'unknown' : chosen.tier === 'prod' ? 'production' : 'nonproduction'
  return (
    <div className="flex flex-col gap-2">
      <ChoiceSelect
        id={`${idBase}-target`}
        label={t('scope.pick.target')}
        what={t('choice.what.targets')}
        permission="targets.read"
        query={targets}
        choices={(page) =>
          page.items.map((target) => ({
            value: target.id,
            label: `${inlineName(target.path, 80) ?? target.id} (${tierLabel(target.tier)})`,
          }))
        }
        placeholder={t('scope.pick.target.placeholder')}
        value={id}
        onChange={onChange}
      />
      <CoverageNote coverage={coverage} hasId={toBindingScope('target', id) !== undefined} />
    </div>
  )
}
