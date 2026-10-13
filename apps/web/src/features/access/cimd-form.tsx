import { Button, Form, FormControl, FormField, Input } from '@exponetdb/ui'
import { FormItemLayout } from '@exponetdb/ui-patterns'
import { zodResolver } from '@hookform/resolvers/zod'
import { type ReactNode, useMemo, useRef } from 'react'
import { useForm } from 'react-hook-form'
import * as z from 'zod'
import { t } from '../../lib/i18n/i18n.ts'
import { useAccessAction } from './actions.ts'
import { accessKeys } from './keys.ts'
import type { StatusLine } from './status.tsx'

/**
 * Adds a client by its Client ID Metadata Document (oauth.md §3): the exact
 * `https` address that is also its `client_id`, no wildcard. The server
 * fetches the document through its hardened fetcher and records the client;
 * the page never fetches it and never follows it. The address is not
 * echoed in the outcome line.
 */
const CIMD_MAX_LENGTH = 512

interface CimdValues {
  clientId: string
}

const DEFAULTS: CimdValues = { clientId: '' }

function cimdSchema() {
  const invalid = t('access.cimd.invalid')
  return z.object({
    clientId: z
      .string()
      .trim()
      .min(9, invalid)
      .max(CIMD_MAX_LENGTH, invalid)
      .refine((value) => value.startsWith('https://'), invalid),
  })
}

export function CimdForm({ line }: { readonly line: StatusLine }): ReactNode {
  const action = useAccessAction()
  const schema = useMemo(cimdSchema, [])
  const form = useForm<CimdValues>({ resolver: zodResolver(schema), defaultValues: DEFAULTS })
  const { isSubmitting } = form.formState
  const inFlight = useRef(false)

  const onSubmit = async (values: CimdValues): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    line.clear()
    try {
      const client = await action.run(
        () =>
          action.client.operation('registerCimdClient', {
            body: { clientId: values.clientId.trim() },
          }),
        accessKeys.oauthClients,
      )
      form.reset(DEFAULTS)
      line.say(
        client.state === 'pending' ? t('access.cimd.done.pending') : t('access.cimd.done.recorded'),
      )
    } catch (error) {
      line.fail(error)
    } finally {
      inFlight.current = false
    }
  }

  return (
    <Form {...form}>
      <form
        id="cimd-add"
        className="flex flex-col gap-4"
        noValidate
        onSubmit={form.handleSubmit(onSubmit)}
      >
        <FormField
          control={form.control}
          name="clientId"
          render={({ field }) => (
            <FormItemLayout
              layout="vertical"
              label={t('access.cimd.label')}
              description={t('access.cimd.hint')}
            >
              <FormControl>
                <Input
                  {...field}
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={CIMD_MAX_LENGTH}
                  required
                />
              </FormControl>
            </FormItemLayout>
          )}
        />
        <div>
          <Button type="submit" variant="default" size="small" loading={isSubmitting}>
            {t('access.cimd.submit')}
          </Button>
        </div>
      </form>
    </Form>
  )
}
