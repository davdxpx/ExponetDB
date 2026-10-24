import {
  BrandGlyph,
  type BrandId,
  Building2,
  CircleHelp,
  Cloud,
  type LucideIcon,
  Server,
} from '@exponetdb/icons'
import type { ServerProvider } from '@exponetdb/sdk/operations'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'

/**
 * Where a server runs (domain-model.md §3.2; the owner's decision S11 of
 * 2026-10-21): every provider of the contract with its group in the
 * register form and its logo. A provider with a Simple Icons glyph shows
 * it (ADR-0033); the others show a neutral glyph, never a logo from
 * elsewhere. The logo is decorative: the provider's name is always written
 * next to it.
 */
export type ProviderGroup = 'cloud' | 'dedicated' | 'other'

/** The groups of the register form, in order, each with its providers sorted by name. */
export const PROVIDER_GROUPS = [
  {
    id: 'cloud',
    providers: [
      'akamai_linode',
      'alibaba_cloud',
      'aws',
      'digitalocean',
      'exoscale',
      'google_cloud',
      'hetzner_cloud',
      'ibm_cloud',
      'azure',
      'oracle_cloud',
      'scaleway',
      'stackit',
      'upcloud',
      'vultr',
    ],
  },
  { id: 'dedicated', providers: ['contabo', 'hetzner_robot', 'ionos', 'netcup', 'ovhcloud'] },
  { id: 'other', providers: ['on_premises', 'other', 'unknown'] },
] as const satisfies readonly {
  readonly id: ProviderGroup
  readonly providers: readonly ServerProvider[]
}[]

type Grouped = (typeof PROVIDER_GROUPS)[number]['providers'][number]
/** Compile-time proof that every provider of the contract has a group (`true`, or a type error). */
export const EVERY_PROVIDER_GROUPED: [Exclude<ServerProvider, Grouped>] extends [never]
  ? true
  : Exclude<ServerProvider, Grouped> = true

type Logo = { readonly brand: BrandId } | { readonly icon: LucideIcon }

// A `Record` over the contract's type: a provider added to the contract fails the type check
// here until it has a logo (a Simple Icons glyph, or a neutral one).
const PROVIDER_LOGO: Readonly<Record<ServerProvider, Logo>> = {
  akamai_linode: { brand: 'akamai' },
  alibaba_cloud: { brand: 'alibabacloud' },
  aws: { icon: Cloud },
  azure: { icon: Cloud },
  contabo: { brand: 'contabo' },
  digitalocean: { brand: 'digitalocean' },
  exoscale: { brand: 'exoscale' },
  google_cloud: { brand: 'googlecloud' },
  hetzner_cloud: { brand: 'hetzner' },
  hetzner_robot: { brand: 'hetzner' },
  ibm_cloud: { icon: Cloud },
  ionos: { brand: 'ionos' },
  netcup: { brand: 'netcup' },
  on_premises: { icon: Building2 },
  oracle_cloud: { icon: Cloud },
  other: { icon: Server },
  ovhcloud: { brand: 'ovh' },
  scaleway: { brand: 'scaleway' },
  stackit: { icon: Cloud },
  unknown: { icon: CircleHelp },
  upcloud: { brand: 'upcloud' },
  vultr: { brand: 'vultr' },
}

export const isProvider = (value: string): value is ServerProvider =>
  Object.hasOwn(PROVIDER_LOGO, value)

/** A provider's logo on a neutral tile (the page background its colors are checked against). */
export function ProviderLogo({ provider }: { readonly provider: ServerProvider }): ReactNode {
  const logo = PROVIDER_LOGO[provider]
  return (
    <span
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-md border border-default bg-background text-foreground"
      data-provider-logo={'brand' in logo ? logo.brand : 'neutral'}
      aria-hidden="true"
    >
      {'brand' in logo ? (
        <BrandGlyph brand={logo.brand} size={14} />
      ) : (
        <logo.icon className="size-3.5 text-foreground-light" strokeWidth={1.75} aria-hidden />
      )}
    </span>
  )
}

/** A provider's logo left of its name. */
export function ProviderName({ provider }: { readonly provider: ServerProvider }): ReactNode {
  return (
    <span className="inline-flex items-center gap-2">
      <ProviderLogo provider={provider} />
      <span>{t(`infra.servers.provider.${provider}`)}</span>
    </span>
  )
}
