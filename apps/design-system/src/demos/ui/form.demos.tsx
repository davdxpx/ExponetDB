import {
  Button,
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormInputGroupInput,
  FormItem,
  FormLabel,
  FormMessage,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupText,
  Switch,
  Textarea,
  useWatch,
} from '@exponetdb/ui'
import { type ReactNode, useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import type { DemoDefinition } from '../types.ts'

interface RegisterValues {
  path: string
  slug: string
  reason: string
  notify: boolean
}

const PATH = /^[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+$/

function Preview(): ReactNode {
  const path = useWatch<RegisterValues, 'path'>({ name: 'path' })
  return (
    <p role="status" className="text-xs text-foreground-lighter">
      {PATH.test(path) ? `A plan will be created for ${path}.` : 'Enter a valid path to continue.'}
    </p>
  )
}

function Register({ validateAtStart }: { readonly validateAtStart: boolean }): ReactNode {
  const form = useForm<RegisterValues>({
    mode: 'onBlur',
    defaultValues: {
      path: validateAtStart ? 'Shop Platform' : 'shop/platform/staging',
      slug: '',
      reason: '',
      notify: true,
    },
  })
  const [result, setResult] = useState<string | null>(null)
  const { trigger } = form

  useEffect(() => {
    if (validateAtStart) void trigger()
  }, [validateAtStart, trigger])

  return (
    <Form {...form}>
      <form
        noValidate
        className="flex max-w-md flex-col gap-5"
        onSubmit={form.handleSubmit((values) => setResult(`Plan created for ${values.path}.`))}
      >
        <FormField
          control={form.control}
          name="path"
          rules={{
            required: 'Enter the target path.',
            pattern: {
              value: PATH,
              message: 'Use product/project/environment in lowercase letters, digits and hyphens.',
            },
          }}
          render={({ field }) => (
            <FormItem className="flex flex-col gap-1.5">
              <FormLabel>Target path</FormLabel>
              <FormControl>
                <Input placeholder="shop/platform/staging" {...field} />
              </FormControl>
              <FormDescription>Product, project and environment.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <Preview />
        <FormField
          control={form.control}
          name="slug"
          rules={{ maxLength: { value: 12, message: 'Use at most 12 characters.' } }}
          render={({ field }) => (
            <FormItem className="flex flex-col gap-1.5">
              <FormLabel>Short name (optional)</FormLabel>
              <InputGroup>
                <InputGroupAddon>
                  <InputGroupText>shop /</InputGroupText>
                </InputGroupAddon>
                <FormInputGroupInput {...field} />
              </InputGroup>
              <FormDescription>Used in notifications.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="reason"
          render={({ field }) => (
            <FormItem className="flex flex-col gap-1.5">
              <FormLabel>Reason (optional)</FormLabel>
              <FormControl>
                <Textarea {...field} />
              </FormControl>
              <FormDescription>Shown to the person who approves the plan.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="notify"
          render={({ field }) => (
            <FormItem className="flex items-center justify-between gap-4">
              <FormLabel>Notify on failure</FormLabel>
              <FormControl>
                <Switch checked={field.value} onCheckedChange={field.onChange} />
              </FormControl>
            </FormItem>
          )}
        />
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary">
            Create plan
          </Button>
          {result === null ? null : (
            <p role="status" className="text-sm text-foreground-light">
              {result}
            </p>
          )}
        </div>
      </form>
    </Form>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui/form/valid',
    title: 'A form with react-hook-form: valid, with a live preview',
    render: () => <Register validateAtStart={false} />,
  },
  {
    id: 'ui/form/invalid',
    title: 'The same form with an invalid path: label, control and message are wired',
    render: () => <Register validateAtStart />,
  },
]
