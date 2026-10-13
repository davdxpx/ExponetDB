import {
  Button,
  Checkbox,
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
  Input,
  Label,
} from '@exponetdb/ui'
import { ConfirmDialog, FormItemLayout } from '@exponetdb/ui-patterns'
import { zodResolver } from '@hookform/resolvers/zod'
import { type ReactNode, useId, useMemo, useRef, useState } from 'react'
import { type Control, useForm, useWatch } from 'react-hook-form'
import { t } from '../../lib/i18n/i18n.ts'
import {
  AUTHORITY_DEFAULTS,
  AUTHORITY_MAX_DAYS,
  type AuthorityValues,
  authoritySchema,
  isProductionWrite,
  type ScopeEffect,
  scopesByEffect,
} from './authority.ts'
import { tierLabel, tiersLabel } from './model.ts'

/**
 * The authority of a machine grant or an API key (identity.md §5). The
 * defaults are the least a key can hold (`targets.read`, non-production,
 * 90 days), summarized above the button; "Change scopes and limits" opens
 * the choice. Scopes are a ceiling, never a permission. Production write
 * authority needs the explicit acknowledgement, which the form asks for only
 * when the choice is one. With `confirm`, a valid choice is confirmed in a
 * dialog first (a new machine grant replaces the active one).
 */
export interface AuthorityConfirm {
  readonly title: string
  readonly description: string
  readonly actionLabel: string
}

export interface AuthorityFormProps {
  /** `apiKey` adds the optional label. */
  readonly kind: 'grant' | 'apiKey'
  readonly submitLabel: string
  readonly confirm?: AuthorityConfirm
  /** Sends the choice. Resolves when it was accepted (the form starts over), rejects otherwise. */
  readonly onSend: (values: AuthorityValues) => Promise<void>
  /** Called with a failure of `onSend` when it was sent without a confirmation. */
  readonly onError: (error: unknown) => void
  /** Called with a failure inside the confirmation (the dialog shows it). */
  readonly toFailure?: (error: unknown) => Error
}

const EFFECT_LABEL: Readonly<Record<ScopeEffect, () => string>> = {
  read: () => t('access.authority.effect.read'),
  control_record: () => t('access.authority.effect.controlRecord'),
  consequential: () => t('access.authority.effect.consequential'),
}

function messages() {
  return {
    scopes: t('access.authority.error.scopes'),
    tiers: t('access.authority.error.tiers'),
    tierOf: (scope: string, tier: 'prod' | 'nonprod') =>
      t('access.authority.error.tierOf', { scope, tier: tierLabel(tier) }),
    production: t('access.authority.error.production'),
    days: t('access.authority.error.days', { max: AUTHORITY_MAX_DAYS }),
    label: t('access.authority.error.label'),
  }
}

export function AuthorityForm({
  kind,
  submitLabel,
  confirm,
  onSend,
  onError,
  toFailure,
}: AuthorityFormProps): ReactNode {
  const schema = useMemo(() => authoritySchema(messages()), [])
  const form = useForm<AuthorityValues>({
    resolver: zodResolver(schema),
    defaultValues: AUTHORITY_DEFAULTS,
  })
  const { isSubmitting } = form.formState
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState<AuthorityValues | null>(null)
  const inFlight = useRef(false)
  const panelId = useId()

  const send = async (values: AuthorityValues): Promise<void> => {
    await onSend(values)
    form.reset(AUTHORITY_DEFAULTS)
    setOpen(false)
  }

  const onValid = async (values: AuthorityValues): Promise<void> => {
    if (confirm !== undefined) {
      setConfirming(values)
      return
    }
    if (inFlight.current) return
    inFlight.current = true
    try {
      await send(values)
    } catch (error) {
      onError(error)
    } finally {
      inFlight.current = false
    }
  }

  return (
    <Form {...form}>
      <form
        className="flex flex-col gap-3"
        noValidate
        // A choice with an error inside the closed panel opens it, so the message is seen.
        onSubmit={form.handleSubmit(onValid, () => setOpen(true))}
      >
        <Summary control={form.control} />
        <div>
          <Button
            type="button"
            variant="text"
            size="tiny"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? t('access.authority.hide') : t('access.authority.edit')}
          </Button>
        </div>
        <div
          id={panelId}
          hidden={!open}
          className={open ? 'flex flex-col gap-4 rounded-md border border-default p-4' : undefined}
        >
          {open ? <Choice control={form.control} kind={kind} /> : null}
        </div>
        <div>
          <Button type="submit" variant="default" size="small" loading={isSubmitting}>
            {submitLabel}
          </Button>
        </div>
      </form>
      {confirm === undefined ? null : (
        <ConfirmDialog
          open={confirming !== null}
          onOpenChange={(next) => {
            if (!next) setConfirming(null)
          }}
          title={confirm.title}
          description={confirm.description}
          actionLabel={confirm.actionLabel}
          onConfirm={async () => {
            if (confirming === null) return
            try {
              await send(confirming)
            } catch (error) {
              throw toFailure === undefined ? error : toFailure(error)
            }
          }}
        />
      )}
    </Form>
  )
}

/** The current choice in one line, always visible next to the button. */
function Summary({ control }: { readonly control: Control<AuthorityValues> }): ReactNode {
  const [scopes, tiers, days] = useWatch({ control, name: ['scopes', 'tiers', 'days'] })
  const params = {
    scopes: scopes.length === 0 ? t('access.authority.none') : scopes.join(' '),
    tiers: tiers.length === 0 ? t('access.authority.none') : tiersLabel(tiers),
    days: days.trim(),
  }
  return (
    <p className="text-sm text-foreground-light">
      {params.days === ''
        ? t('access.authority.summary.noDays', params)
        : t('access.authority.summary', params)}
    </p>
  )
}

function Choice({
  control,
  kind,
}: {
  readonly control: Control<AuthorityValues>
  readonly kind: 'grant' | 'apiKey'
}): ReactNode {
  const baseId = useId()
  const [scopes, tiers] = useWatch({ control, name: ['scopes', 'tiers'] })
  const productionWrite = isProductionWrite(scopes, tiers)
  return (
    <>
      <FormField
        control={control}
        name="scopes"
        render={({ field }) => (
          <FormItem>
            <fieldset className="flex flex-col gap-3">
              <legend className="text-sm text-foreground">{t('access.authority.scopes')}</legend>
              <p className="text-sm text-foreground-lighter">
                {t('access.authority.scopes.description')}
              </p>
              {scopesByEffect().map((group) => (
                <div key={group.effect} className="flex flex-col gap-2">
                  <p className="text-xs font-medium text-foreground-light">
                    {EFFECT_LABEL[group.effect]()}
                  </p>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {group.scopes.map((entry) => {
                      const id = `${baseId}-${entry.scope}`
                      return (
                        <div key={entry.scope} className="flex items-center gap-2">
                          <Checkbox
                            id={id}
                            checked={field.value.includes(entry.scope)}
                            onCheckedChange={(checked) =>
                              field.onChange(
                                checked === true
                                  ? [...field.value.filter((s) => s !== entry.scope), entry.scope]
                                  : field.value.filter((s) => s !== entry.scope),
                              )
                            }
                          />
                          <Label htmlFor={id} className="font-mono text-xs text-foreground">
                            {entry.scope}
                          </Label>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </fieldset>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={control}
        name="tiers"
        render={({ field }) => (
          <FormItem>
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm text-foreground">{t('access.authority.tiers')}</legend>
              {(['nonprod', 'prod'] as const).map((tier) => {
                const id = `${baseId}-tier-${tier}`
                return (
                  <div key={tier} className="flex items-center gap-2">
                    <Checkbox
                      id={id}
                      checked={field.value.includes(tier)}
                      onCheckedChange={(checked) =>
                        field.onChange(
                          checked === true
                            ? [...field.value.filter((v) => v !== tier), tier]
                            : field.value.filter((v) => v !== tier),
                        )
                      }
                    />
                    <Label htmlFor={id} className="text-sm text-foreground">
                      {tierLabel(tier)}
                    </Label>
                  </div>
                )
              })}
            </fieldset>
            <FormMessage />
          </FormItem>
        )}
      />
      {productionWrite ? (
        <FormField
          control={control}
          name="acknowledgeProduction"
          render={({ field }) => (
            <FormItemLayout
              layout="flex"
              label={t('access.authority.production')}
              description={t('access.authority.production.description')}
            >
              <FormControl>
                <Checkbox
                  checked={field.value}
                  onCheckedChange={(checked) => field.onChange(checked === true)}
                  onBlur={field.onBlur}
                  name={field.name}
                  ref={field.ref}
                />
              </FormControl>
            </FormItemLayout>
          )}
        />
      ) : null}
      <FormField
        control={control}
        name="days"
        render={({ field }) => (
          <FormItemLayout
            layout="vertical"
            label={t('access.authority.days', { max: AUTHORITY_MAX_DAYS })}
          >
            <FormControl>
              <Input
                {...field}
                type="number"
                inputMode="numeric"
                min={1}
                max={AUTHORITY_MAX_DAYS}
                step={1}
                autoComplete="off"
                className="max-w-32"
              />
            </FormControl>
          </FormItemLayout>
        )}
      />
      {kind === 'apiKey' ? (
        <FormField
          control={control}
          name="label"
          render={({ field }) => (
            <FormItemLayout
              layout="vertical"
              label={t('access.authority.label')}
              description={t('access.authority.label.description')}
            >
              <FormControl>
                <Input {...field} maxLength={64} autoComplete="off" spellCheck={false} />
              </FormControl>
            </FormItemLayout>
          )}
        />
      ) : null}
    </>
  )
}
