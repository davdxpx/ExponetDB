import type { ConsentView } from '@exponetdb/contracts'
import { Button } from '@exponetdb/ui'
import { Admonition, formatUtc, ShimmeringLoader, UntrustedName } from '@exponetdb/ui-patterns'
import { type ReactNode, useEffect, useState } from 'react'
import {
  InitialTile,
  InterstitialLayout,
  LogoPair,
  ProductTile,
} from '../../layouts/interstitial-layout.tsx'
import { describeError, t } from '../../lib/i18n/i18n.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import type { Me } from '../../lib/session/guard.tsx'
import { ConsentForm } from './consent-form.tsx'
import { type ConsentDecision, consentWarnings, expiryDelay } from './consent-model.ts'
import { DetailRows, signedInRow } from './consent-parts.tsx'
import { inlineName } from './inline-name.ts'

/**
 * The screens of an authorization request on the interstitial layout
 * (order Appendix A): the request with its facts, warnings and decision,
 * the loading skeleton, the states a request can end in (not valid, no
 * longer open, could not be read, expired) and the result. The consent page
 * and the device code page share them; a device request is the same
 * ceremony with the code check in front.
 */
function clientLogo(view: ConsentView): ReactNode {
  return <LogoPair left={<InitialTile name={view.client.name} />} right={<ProductTile />} />
}

function titleOf(view: ConsentView): string {
  const name = inlineName(view.client.name)
  return name === undefined ? t('consent.title.unnamed') : t('consent.title', { name })
}

/** Becomes true when the request expires on this browser's clock (never when the clocks disagree). */
function useExpired(expiresAt: string): boolean {
  const [expired, setExpired] = useState(false)
  useEffect(() => {
    setExpired(false)
    const delay = expiryDelay(expiresAt, Date.now())
    if (delay === undefined) return
    // setTimeout holds at most 2^31 - 1 ms; a request is open for minutes.
    const timer = setTimeout(() => setExpired(true), Math.min(delay, 2_147_483_647))
    return () => clearTimeout(timer)
  }, [expiresAt])
  return expired
}

export interface ConsentScreenProps {
  readonly view: ConsentView
  readonly me: Me
  readonly onDecide: (decision: ConsentDecision) => Promise<void>
  /** Shown above the warnings (the device code check). */
  readonly preface?: ReactNode
}

/** The open request: header, warnings, the request's facts, "Where", permissions, footer. */
export function ConsentScreen({ view, me, onDecide, preface }: ConsentScreenProps): ReactNode {
  const expired = useExpired(view.expiresAt)
  const warnings = consentWarnings(view)
  const client = view.client
  return (
    <InterstitialLayout
      logo={clientLogo(view)}
      title={titleOf(view)}
      description={t('consent.description')}
    >
      <div className="flex flex-col gap-5 px-6 pb-6">
        {expired ? (
          <Admonition
            type="warning"
            title={t('consent.expired.title')}
            description={t('consent.expired.body')}
          />
        ) : (
          <>
            {preface}
            {warnings.lookalike ? (
              <Admonition
                id="lookalike"
                role="alert"
                type="warning"
                title={t('consent.lookalike.title')}
                description={t('consent.lookalike.body')}
              />
            ) : null}
            {warnings.trifecta ? (
              <Admonition
                id="trifecta-warning"
                role="note"
                type="warning"
                title={t('consent.trifecta.title')}
                description={t('consent.trifecta.body')}
              />
            ) : null}
            <DetailRows
              rows={[
                {
                  id: 'client',
                  label: t('consent.client.label'),
                  valueId: 'consent-client',
                  value: (
                    <span className="inline-flex flex-wrap items-baseline justify-end gap-1.5">
                      <UntrustedName
                        name={client.name}
                        unverified={!client.firstParty}
                        maxCodePoints={100}
                        label={t('consent.client.label')}
                      />
                      {client.firstParty ? (
                        <span className="rounded-sm border border-default px-1 text-[11px] leading-4 text-foreground-light">
                          {t('consent.client.firstParty')}
                        </span>
                      ) : null}
                    </span>
                  ),
                },
                {
                  id: 'client-id',
                  label: t('consent.clientId.label'),
                  value: (
                    <UntrustedName
                      name={client.clientId}
                      mono
                      maxCodePoints={512}
                      label={t('consent.clientId.label')}
                    />
                  ),
                },
                {
                  id: 'redirect',
                  label: t('consent.redirect.label'),
                  valueId: 'consent-redirect',
                  value: client.loopbackRedirect ? (
                    t('consent.redirect.loopback')
                  ) : client.redirectHost === null ? (
                    t('consent.redirect.device')
                  ) : (
                    <strong className={client.lookalike ? 'text-warning-600' : undefined}>
                      <UntrustedName name={client.redirectHost} maxCodePoints={256} />
                    </strong>
                  ),
                },
                {
                  id: 'resource',
                  label: t('consent.resource.label'),
                  value: (
                    <span className="inline-flex flex-col items-end">
                      <span>
                        {t(
                          view.resource === 'mcp' ? 'consent.resource.mcp' : 'consent.resource.api',
                        )}
                      </span>
                      <span className="font-mono text-foreground-light">{view.resourceUri}</span>
                    </span>
                  ),
                },
                {
                  id: 'expires',
                  label: t('consent.expires.label'),
                  value: formatUtc(view.expiresAt) ?? view.expiresAt,
                },
                signedInRow(me),
              ]}
            />
            <ConsentForm view={view} onDecide={onDecide} />
          </>
        )}
      </div>
    </InterstitialLayout>
  )
}

export interface DecisionScreenProps {
  readonly view: ConsentView
  readonly me: Me
  readonly decision: ConsentDecision
  readonly title: string
  /** The outcome sentence (or the refusal to leave), under the header. */
  readonly children: ReactNode
}

/** What was decided: for an approval, who authorized it, where and the permissions granted. */
export function DecisionScreen({
  view,
  me,
  decision,
  title,
  children,
}: DecisionScreenProps): ReactNode {
  return (
    <InterstitialLayout logo={clientLogo(view)} title={title}>
      <div className="flex flex-col gap-5 px-6 pb-6">
        {children}
        {decision.decision === 'allow' ? (
          <>
            <DetailRows
              rows={[
                signedInRow(me, t('consent.success.authorizedBy')),
                { id: 'where', label: t('consent.success.where'), value: whereSummary(decision) },
              ]}
            />
            <section className="flex flex-col gap-2">
              <h2 className="text-xs text-foreground">{t('consent.success.permissions')}</h2>
              <ul className="m-0 flex list-none flex-col divide-y divide-border rounded-md border bg-surface-75 px-4 py-0">
                {decision.scopes.map((scope) => (
                  <li key={scope} className="py-2 font-mono text-xs text-foreground">
                    {scope}
                  </li>
                ))}
              </ul>
            </section>
          </>
        ) : null}
      </div>
    </InterstitialLayout>
  )
}

/** The success title of an approved request. */
export function connectedTitle(view: ConsentView): string {
  const name = inlineName(view.client.name)
  return name === undefined
    ? t('consent.success.title.unnamed')
    : t('consent.success.title', { name })
}

function whereSummary(decision: ConsentDecision): string {
  if (decision.targets?.kind === 'list') {
    return t('consent.where.summary.list', { count: decision.targets.targetIds.length })
  }
  const prod = decision.tiers.includes('prod')
  const nonprod = decision.tiers.includes('nonprod')
  if (prod && nonprod) return t('consent.where.summary.both')
  return t(prod ? 'consent.where.summary.prod' : 'consent.where.summary.nonprod')
}

/** While the request is read: a skeleton of the card, busy for assistive technology. */
export function LoadingScreen(): ReactNode {
  return (
    <InterstitialLayout logo={<ProductTile />} title={t('consent.loading')}>
      <div aria-busy="true" className="flex flex-col gap-5 px-6 pb-6">
        <ShimmeringLoader className="h-[34px] w-full py-0" />
        <ShimmeringLoader className="h-24 w-full rounded-md py-0" />
        <ShimmeringLoader className="h-32 w-full rounded-md py-0" />
        <ShimmeringLoader className="h-9 w-full py-0" />
      </div>
    </InterstitialLayout>
  )
}

/** A handle or a link that is not one this page accepts: fixed text, nothing of the address echoed. */
export function InvalidRequestScreen(): ReactNode {
  return (
    <InterstitialLayout logo={<ProductTile />} title={t('consent.invalid.title')}>
      <div className="px-6 pb-6">
        <Admonition type="warning" description={t('consent.invalid.body')} />
      </div>
    </InterstitialLayout>
  )
}

/**
 * A request that could not be read. The server's refusals (unknown,
 * expired, already decided, another browser, a client no longer approved)
 * end the request; a network or availability failure can be tried again.
 * The session gone is the API client's: it already leaves for sign-in.
 */
export function ReadFailedScreen({
  error,
  onRetry,
}: {
  readonly error: unknown
  readonly onRetry: () => void
}): ReactNode {
  const kind = classifyFailure(error).kind
  if (kind === 'session') {
    return (
      <p role="status" className="p-6 text-sm text-foreground-light">
        {t('session.leaving')}
      </p>
    )
  }
  const final = kind === 'invalid' || kind === 'not_permitted' || kind === 'not_found'
  return (
    <InterstitialLayout
      logo={<ProductTile />}
      title={t(final ? 'consent.closed.title' : 'consent.failed.title')}
    >
      <div className="flex flex-col gap-3 px-6 pb-6">
        <Admonition
          type="warning"
          description={
            <>
              <p>{describeError(error)}</p>
              {final ? <p>{t('consent.invalid.body')}</p> : null}
            </>
          }
        />
        {final ? null : (
          <Button type="button" variant="default" size="medium" block onClick={onRetry}>
            {t('state.retry')}
          </Button>
        )}
      </div>
    </InterstitialLayout>
  )
}
