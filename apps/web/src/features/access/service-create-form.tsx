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
 * Creates a service account (`#service-create`, identity.md §5): a name
 * only. It starts active with no role and no credential; the responsible
 * person is the creator. Re-authentication when the server asks for it.
 */
const NAME_MAX_LENGTH = 128

interface CreateValues {
  name: string
}

const DEFAULTS: CreateValues = { name: '' }

function createSchema() {
  const invalid = t('access.services.create.invalid')
  return z.object({
    name: z
      .string()
      .trim()
      .min(1, invalid)
      .max(NAME_MAX_LENGTH, invalid)
      .regex(/^[^\p{Cc}]+$/u, invalid),
  })
}

export function ServiceCreateForm({ line }: { readonly line: StatusLine }): ReactNode {
  const action = useAccessAction()
  const schema = useMemo(createSchema, [])
  const form = useForm<CreateValues>({ resolver: zodResolver(schema), defaultValues: DEFAULTS })
  const { isSubmitting } = form.formState
  const inFlight = useRef(false)

  const onSubmit = async (values: CreateValues): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    line.clear()
    try {
      await action.run(
        () =>
          action.client.operation('createServiceAccount', {
            body: { displayName: values.name.trim() },
          }),
        accessKeys.serviceAccounts,
      )
      form.reset(DEFAULTS)
      line.say(t('access.services.create.done'))
    } catch (error) {
      line.fail(error)
    } finally {
      inFlight.current = false
    }
  }

  return (
    <Form {...form}>
      <form
        id="service-create"
        className="flex flex-col gap-4"
        noValidate
        onSubmit={form.handleSubmit(onSubmit)}
      >
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItemLayout
              layout="vertical"
              label={t('access.services.create.name')}
              description={t('access.services.create.hint')}
            >
              <FormControl>
                <Input {...field} maxLength={NAME_MAX_LENGTH} autoComplete="off" required />
              </FormControl>
            </FormItemLayout>
          )}
        />
        <div>
          <Button type="submit" variant="default" size="small" loading={isSubmitting}>
            {t('access.services.create.submit')}
          </Button>
        </div>
      </form>
    </Form>
  )
}
