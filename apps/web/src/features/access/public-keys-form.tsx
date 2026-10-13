import { Button, Form, FormControl, FormField, Textarea } from '@exponetdb/ui'
import { ConfirmDialog, FormItemLayout } from '@exponetdb/ui-patterns'
import { zodResolver } from '@hookform/resolvers/zod'
import { type ReactNode, useMemo, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import * as z from 'zod'
import { t } from '../../lib/i18n/i18n.ts'
import { useAccessAction } from './actions.ts'
import { type PublicJwks, parseJwks } from './jwks.ts'
import { accessKeys } from './keys.ts'
import type { ServiceAccount } from './model.ts'
import { actionFailed, type StatusLine } from './status.tsx'

/**
 * The public keys of a service account's client (identity.md §5): the
 * first set registers the client (`Register client`), a later one replaces
 * every key after a confirmation (`Replace keys`). A pasted private key is
 * refused before anything is sent and the field is cleared at once; the
 * field is cleared after a successful send too.
 */
interface KeysValues {
  jwks: string
}

const DEFAULTS: KeysValues = { jwks: '' }

function keysSchema() {
  return z.object({ jwks: z.string().trim().min(1, t('access.service.keys.required')) })
}

export function PublicKeysForm({
  account,
  line,
}: {
  readonly account: ServiceAccount
  readonly line: StatusLine
}): ReactNode {
  const action = useAccessAction()
  const schema = useMemo(keysSchema, [])
  const form = useForm<KeysValues>({ resolver: zodResolver(schema), defaultValues: DEFAULTS })
  const { isSubmitting } = form.formState
  const [replacing, setReplacing] = useState<PublicJwks | null>(null)
  const inFlight = useRef(false)
  const registered = account.client !== null
  const params = { identityId: account.id }

  const send = async (jwks: PublicJwks): Promise<void> => {
    await action.run(
      () =>
        registered
          ? action.client.operation('replaceServiceAccountClientKeys', { params, body: { jwks } })
          : action.client.operation('registerServiceAccountClient', { params, body: { jwks } }),
      accessKeys.serviceAccounts,
    )
    form.reset(DEFAULTS)
    line.say(registered ? t('access.service.keys.replaced') : t('access.service.keys.registered'))
  }

  const onValid = async (values: KeysValues): Promise<void> => {
    line.clear()
    const parsed = parseJwks(values.jwks)
    if (!parsed.ok) {
      if (parsed.reason === 'private') {
        // A private key never stays in the page: the field is emptied before anything else.
        form.reset(DEFAULTS)
        form.setError('jwks', { type: 'private', message: t('access.service.keys.private') })
        return
      }
      form.setError('jwks', {
        type: parsed.reason,
        message:
          parsed.reason === 'json' ? t('access.service.keys.json') : t('access.service.keys.shape'),
      })
      return
    }
    if (registered) {
      setReplacing(parsed.jwks)
      return
    }
    if (inFlight.current) return
    inFlight.current = true
    try {
      await send(parsed.jwks)
    } catch (error) {
      line.fail(error)
    } finally {
      inFlight.current = false
    }
  }

  return (
    <Form {...form}>
      <form className="flex flex-col gap-3" noValidate onSubmit={form.handleSubmit(onValid)}>
        <FormField
          control={form.control}
          name="jwks"
          render={({ field }) => (
            <FormItemLayout
              layout="vertical"
              label={t('access.service.keys.label')}
              description={t('access.service.keys.hint')}
            >
              <FormControl>
                <Textarea
                  {...field}
                  rows={4}
                  required
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  className="font-mono text-xs"
                />
              </FormControl>
            </FormItemLayout>
          )}
        />
        <div>
          <Button type="submit" variant="default" size="small" loading={isSubmitting}>
            {registered ? t('access.service.keys.replace') : t('access.service.keys.register')}
          </Button>
        </div>
      </form>
      {registered ? (
        <ConfirmDialog
          open={replacing !== null}
          onOpenChange={(next) => {
            if (!next) setReplacing(null)
          }}
          title={t('access.service.keys.replace.title')}
          description={t('access.service.keys.replace.body')}
          actionLabel={t('access.service.keys.replace.action')}
          onConfirm={async () => {
            if (replacing === null) return
            try {
              await send(replacing)
            } catch (error) {
              throw actionFailed(error)
            }
          }}
        />
      ) : null}
    </Form>
  )
}
