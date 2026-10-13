import type { ConsentView, Tier } from '@exponetdb/contracts'
import { Badge, Button, Input, Label } from '@exponetdb/ui'
import { Admonition, TierChip, UntrustedName } from '@exponetdb/ui-patterns'
import { type FormEvent, type ReactNode, useId, useState } from 'react'
import { describeError, t } from '../../lib/i18n/i18n.ts'
import {
  allowBlocker,
  type ConsentChoice,
  type ConsentDecision,
  effectLabel,
  initialChoice,
  needsFreshProof,
  reachesProduction,
  type ScopeOffer,
  scopesByEffect,
  tierChosen,
  toDecision,
  withTier,
} from './consent-model.ts'
import { ChoiceRow, SectionHeading, withNodes } from './consent-parts.tsx'
import { inlineName } from './inline-name.ts'

/**
 * The decision part of the consent screen (order Appendix A, oauth.md §4):
 * "Where" (the kinds of targets, non-production preselected, production an
 * explicit opt-in with its acknowledgement, optionally only some targets),
 * the permissions grouped by what they do (only what the view offers and
 * the person holds; the rest listed as not granted), the lifetime, and the
 * footer with "Authorize {name}" and "Cancel". The controls are native
 * inputs named `where`, `target`, `tier`, `production`, `scope` and `days`
 * (the browser suites select them). The model shapes the request body; the
 * server decides again when it arrives.
 */
export interface ConsentFormProps {
  readonly view: ConsentView
  /** Sends the decision. A rejection is shown in the footer; the form stays. */
  readonly onDecide: (decision: ConsentDecision) => Promise<void>
}

const TIER_LABEL = {
  nonprod: 'consent.tier.nonprod',
  prod: 'consent.tier.prod',
} as const

export function ConsentForm({ view, onDecide }: ConsentFormProps): ReactNode {
  const [choice, setChoice] = useState<ConsentChoice>(() => initialChoice(view))
  const [days, setDays] = useState(() => String(view.lifetimeDays.default))
  const [busy, setBusy] = useState<'allow' | 'deny' | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const ids = {
    where: useId(),
    permissions: useId(),
    days: useId(),
    daysHint: useId(),
    blocker: useId(),
  }

  const blocker = allowBlocker(view, choice)
  const production = reachesProduction(view, choice)
  const groups = scopesByEffect(view)
    .map((group) => ({ ...group, offers: group.offers.filter((o) => o.available) }))
    .filter((group) => group.offers.length > 0)
  const unavailable = view.scopes.filter((o) => !o.available)
  const name = inlineName(view.client.name)

  const decide = async (decision: 'allow' | 'deny'): Promise<void> => {
    if (busy !== undefined) return
    // Enter in a field submits even while "Authorize" only looks disabled.
    if (decision === 'allow' && allowBlocker(view, choice) !== undefined) return
    setBusy(decision)
    setError(undefined)
    try {
      await onDecide(toDecision(view, choice, decision))
    } catch (failure) {
      setError(describeError(failure))
      setBusy(undefined)
    }
  }

  const toggleScope = (scope: string, on: boolean): void => {
    setChoice((current) => {
      const scopes = new Set(current.scopes)
      if (on) scopes.add(scope)
      else scopes.delete(scope)
      return { ...current, scopes }
    })
  }
  const toggleTarget = (id: string, on: boolean): void => {
    setChoice((current) => {
      const targets = new Set(current.targets)
      if (on) targets.add(id)
      else targets.delete(id)
      return { ...current, targets }
    })
  }
  const toggleTier = (tier: Tier, on: boolean): void => {
    setChoice((current) => withTier(view, current, tier, on))
  }

  return (
    <form
      id="consent-form"
      className="flex flex-col gap-5"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        void decide('allow')
      }}
    >
      <fieldset
        disabled={busy !== undefined}
        className="m-0 flex min-w-0 flex-col gap-5 border-0 p-0"
      >
        <section aria-labelledby={ids.where} className="flex flex-col gap-3">
          <SectionHeading id={ids.where}>{t('consent.where.title')}</SectionHeading>
          <fieldset className="m-0 min-w-0 divide-y divide-border rounded-md border bg-surface-75 p-0">
            <legend className="sr-only">{t('consent.where.tiers')}</legend>
            {(['nonprod', 'prod'] as const).map((tier) => (
              <ChoiceRow
                key={tier}
                type="checkbox"
                name="tier"
                value={tier}
                checked={choice.tiers.has(tier)}
                onChange={(on) => toggleTier(tier, on)}
                label={
                  <>
                    <span>{t(TIER_LABEL[tier])}</span>
                    {tier === 'prod' ? (
                      // The chip repeats the label for the eye (production is framed distinctly).
                      <span aria-hidden="true">
                        <TierChip tier="prod" />
                      </span>
                    ) : null}
                  </>
                }
                hint={t(tier === 'prod' ? 'consent.tier.prod.hint' : 'consent.tier.nonprod.hint')}
              />
            ))}
          </fieldset>
          {production ? (
            <div className="rounded-md border border-production">
              <ChoiceRow
                type="checkbox"
                name="production"
                value="yes"
                checked={choice.production}
                onChange={(on) => setChoice((current) => ({ ...current, production: on }))}
                label={t('consent.production.ack')}
              />
            </div>
          ) : null}
          {view.targets.length === 0 ? null : (
            <TargetChoice
              view={view}
              choice={choice}
              onWhere={(where) => setChoice((current) => ({ ...current, where }))}
              onTarget={toggleTarget}
            />
          )}
        </section>

        <section aria-labelledby={ids.permissions} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <SectionHeading id={ids.permissions}>{t('consent.permissions.title')}</SectionHeading>
            <p className="text-xs text-foreground-lighter">{t('consent.permissions.hint')}</p>
          </div>
          {groups.length === 0 ? null : (
            <div className="divide-y divide-border rounded-md border bg-surface-75">
              {groups.map((group) => (
                <fieldset key={group.effect} className="m-0 min-w-0 border-0 p-0 py-1">
                  <legend className="px-3 pt-2.5">
                    <Badge
                      className="badge"
                      variant={group.effect === 'consequential' ? 'warning' : 'default'}
                    >
                      {/* Set in capitals by the badge; the text is lower case as the Wave 7 page had it. */}
                      {effectLabel(group.effect).toLocaleLowerCase('en-US')}
                    </Badge>
                  </legend>
                  {group.offers.map((offer) => (
                    <ScopeRow
                      key={offer.scope}
                      offer={offer}
                      choice={choice}
                      onChange={(on) => toggleScope(offer.scope, on)}
                    />
                  ))}
                </fieldset>
              ))}
            </div>
          )}
          {unavailable.length === 0 ? null : (
            <div className="flex flex-col gap-1.5">
              <h3 className="text-xs text-foreground-light">{t('consent.unavailable.title')}</h3>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {unavailable.map((offer) => (
                  <li key={offer.scope} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                    <code className="font-mono text-foreground-light">{offer.scope}</code>
                    <span className="text-foreground-lighter">
                      {t(
                        offer.reason === 'not_held'
                          ? 'consent.unavailable.not_held'
                          : 'consent.unavailable.not_grantable',
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.days}>{t('consent.lifetime.label')}</Label>
          <Input
            id={ids.days}
            name="days"
            type="number"
            inputMode="numeric"
            min={1}
            max={view.lifetimeDays.max}
            step={1}
            required
            value={days}
            aria-describedby={ids.daysHint}
            className="w-28"
            onChange={(event) => {
              const text = event.currentTarget.value
              setDays(text)
              setChoice((current) => ({ ...current, lifetimeDays: Number(text) }))
            }}
          />
          <p id={ids.daysHint} className="text-xs text-foreground-lighter">
            {t('consent.lifetime.hint', { max: view.lifetimeDays.max })}
          </p>
        </div>

        {needsFreshProof(view, choice) ? (
          <Admonition
            type="info"
            description={t('consent.reauth.note', {
              minutes: Math.max(1, Math.round(view.reauth.withinSeconds / 60)),
            })}
          />
        ) : null}
      </fieldset>

      <div className="flex flex-col gap-2">
        <Button
          type="submit"
          id="consent-allow"
          variant="primary"
          size="medium"
          block
          loading={busy === 'allow'}
          disabled={busy !== undefined || blocker !== undefined}
          focusableWhenDisabled={blocker !== undefined}
          aria-describedby={blocker === undefined ? undefined : ids.blocker}
        >
          {name === undefined ? t('consent.allow.unnamed') : t('consent.allow', { name })}
        </Button>
        {blocker === undefined ? null : (
          <p id={ids.blocker} className="text-center text-xs text-foreground-light">
            {blocker}
          </p>
        )}
        <Button
          type="button"
          id="consent-deny"
          variant="text"
          size="medium"
          block
          loading={busy === 'deny'}
          disabled={busy !== undefined}
          onClick={() => void decide('deny')}
        >
          {t('consent.cancel')}
        </Button>
      </div>
      {error === undefined ? (
        <p className="border-t border-muted pt-5 text-center text-xs text-foreground-lighter text-balance">
          <RedirectSentence view={view} />
        </p>
      ) : (
        <p role="alert" className="border-t pt-5 text-center text-xs text-destructive text-balance">
          {error}
        </p>
      )}
    </form>
  )
}

function ScopeRow({
  offer,
  choice,
  onChange,
}: {
  readonly offer: ScopeOffer
  readonly choice: ConsentChoice
  readonly onChange: (on: boolean) => void
}): ReactNode {
  const allowed = tierChosen(offer, choice.tiers)
  return (
    <ChoiceRow
      type="checkbox"
      name="scope"
      value={offer.scope}
      checked={allowed && choice.scopes.has(offer.scope)}
      disabled={!allowed}
      onChange={onChange}
      label={
        <>
          <code className="font-mono text-xs">{offer.scope}</code>
          {offer.tier === null ? null : <TierChip tier={offer.tier} />}
        </>
      }
      hint={
        allowed || offer.tier === null
          ? undefined
          : t('consent.scope.needsTier', { tier: t(TIER_LABEL[offer.tier]) })
      }
    />
  )
}

function TargetChoice({
  view,
  choice,
  onWhere,
  onTarget,
}: {
  readonly view: ConsentView
  readonly choice: ConsentChoice
  readonly onWhere: (where: 'all' | 'list') => void
  readonly onTarget: (id: string, on: boolean) => void
}): ReactNode {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
      <legend className="mb-1.5 text-xs text-foreground-light">
        {t('consent.targets.legend')}
      </legend>
      <div className="divide-y divide-border rounded-md border bg-surface-75">
        <ChoiceRow
          type="radio"
          name="where"
          value="all"
          checked={choice.where === 'all'}
          onChange={(on) => on && onWhere('all')}
          label={t('consent.targets.all')}
        />
        <ChoiceRow
          type="radio"
          name="where"
          value="list"
          checked={choice.where === 'list'}
          onChange={(on) => on && onWhere('list')}
          label={t('consent.targets.list')}
        />
      </div>
      {choice.where === 'list' ? (
        <fieldset className="m-0 max-h-56 min-w-0 divide-y divide-border overflow-y-auto rounded-md border p-0">
          <legend className="sr-only">{t('consent.targets.list')}</legend>
          {view.targets.map((target) => {
            const allowed = choice.tiers.has(target.tier)
            return (
              <ChoiceRow
                key={target.id}
                type="checkbox"
                name="target"
                value={target.id}
                checked={allowed && choice.targets.has(target.id)}
                disabled={!allowed}
                onChange={(on) => onTarget(target.id, on)}
                label={
                  <>
                    <UntrustedName name={target.path} mono maxCodePoints={120} />
                    <TierChip tier={target.tier} />
                  </>
                }
                hint={allowed ? undefined : t('consent.targets.needsTier')}
              />
            )
          })}
        </fieldset>
      ) : null}
    </fieldset>
  )
}

/** Where the decision sends the browser (or, for a device, what it lets happen). */
function RedirectSentence({ view }: { readonly view: ConsentView }): ReactNode {
  const client = view.client
  if (view.kind === 'device') return t('consent.footer.device')
  if (client.loopbackRedirect) return t('consent.footer.loopback')
  if (client.redirectHost === null) return t('consent.footer.device')
  return withNodes(t('consent.footer.redirect'), {
    host: (
      <strong
        className={
          client.lookalike ? 'font-medium text-warning-600' : 'font-medium text-foreground'
        }
      >
        <UntrustedName name={client.redirectHost} maxCodePoints={256} />
      </strong>
    ),
  })
}
