import type { EndpointRequest } from '@exponetdb/sdk/operations'
import type { MessageKey } from '../../lib/i18n/i18n.ts'
import { isAddress } from '../configuration/connect-model.ts'

/**
 * What the pages that register a cluster or add an endpoint check before they
 * ask the server for a plan, and the request they send. The checks follow the
 * contract (`EndpointRequest`, `ClusterRegisterRequest`); the server decides
 * every rule again (an address another cluster already uses, a CA bundle that
 * does not parse) and its refusal is shown with its code. Pure functions,
 * unit-tested with hostile input.
 */
export const ENDPOINT_KINDS = ['private', 'public', 'pooler', 'local_socket'] as const
export type EndpointKind = (typeof ENDPOINT_KINDS)[number]
export type PoolerMode = 'session' | 'transaction'

export const MAX_ENDPOINTS = 8
export const MAX_CA_BUNDLE = 65_536

/** One endpoint as typed: every field is text. */
export interface EndpointDraft {
  readonly kind: EndpointKind
  readonly host: string
  readonly port: string
  readonly label: string
  readonly tlsServerName: string
  readonly poolerMode: PoolerMode | ''
}

export function emptyEndpoint(kind: EndpointKind = 'private'): EndpointDraft {
  return { kind, host: '', port: '5432', label: '', tlsServerName: '', poolerMode: '' }
}

export type EndpointField = 'host' | 'port' | 'label' | 'tls' | 'poolerMode'
export type EndpointProblems = Partial<Record<EndpointField, MessageKey>>

const HOST = /^[A-Za-z0-9.:-]{1,253}$/
const TLS_NAME = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/
const LABEL = /^[^\p{Cc}]{1,64}$/u
const PORT = /^[0-9]{1,5}$/

/** What is wrong with a typed endpoint, by field; empty when it can be sent. */
export function endpointProblems(draft: EndpointDraft): EndpointProblems {
  const problems: { -readonly [K in EndpointField]?: MessageKey } = {}
  const host = draft.host.trim()
  if (!HOST.test(host)) problems.host = 'infra.endpoint.host.invalid'
  const port = draft.port.trim()
  if (!PORT.test(port) || Number(port) < 1 || Number(port) > 65_535) {
    problems.port = 'infra.endpoint.port.invalid'
  }
  if (!LABEL.test(draft.label.trim())) problems.label = 'infra.endpoint.label.invalid'
  const tls = draft.tlsServerName.trim()
  if (tls === '') {
    // A DNS host is its own TLS server name; an address is not a name a certificate carries.
    if (problems.host === undefined && isAddress(host)) problems.tls = 'infra.endpoint.tls.required'
  } else if (!TLS_NAME.test(tls)) {
    problems.tls = 'infra.endpoint.tls.invalid'
  }
  if (draft.kind === 'pooler' && draft.poolerMode === '') {
    problems.poolerMode = 'infra.endpoint.poolerMode.required'
  }
  return problems
}

/** The request of a valid draft: the pooler mode only for a pooler, the TLS name only when typed. */
export function endpointRequest(draft: EndpointDraft): EndpointRequest {
  const tls = draft.tlsServerName.trim()
  return {
    kind: draft.kind,
    host: draft.host.trim(),
    port: Number(draft.port.trim()),
    label: draft.label.trim(),
    ...(tls === '' ? {} : { tlsServerName: tls }),
    ...(draft.kind === 'pooler' && draft.poolerMode !== '' ? { poolerMode: draft.poolerMode } : {}),
  }
}

export type CaBundleProblem = 'required' | 'key' | 'long'

/**
 * What is wrong with a pasted CA bundle before it is sent. A private key is
 * refused here and never leaves the page (the server refuses it too); the
 * check is on the text, not on parsing it.
 */
export function caBundleProblem(text: string): CaBundleProblem | undefined {
  if (/PRIVATE KEY/.test(text)) return 'key'
  if (text.length > MAX_CA_BUNDLE) return 'long'
  return /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/.test(text)
    ? undefined
    : 'required'
}

/** A database name of the contract: 1 to 63 characters, no control character. */
const DATABASE_NAME = /^[^\p{Cc}]{1,63}$/u
export function isDatabaseName(value: string): boolean {
  return DATABASE_NAME.test(value)
}

/** The display name of a cluster: 1 to 120 characters, no control character. */
const CLUSTER_NAME = /^[^\p{Cc}]{1,120}$/u
export function isClusterName(value: string): boolean {
  return CLUSTER_NAME.test(value)
}
