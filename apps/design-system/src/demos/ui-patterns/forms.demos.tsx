import { Button, Form, FormControl, FormField, Input, Switch } from '@exponetdb/ui'
import {
  FormItemLayout,
  FormLayout,
  getKeyValueFieldArrayValidationIssues,
  KeyValueFieldArray,
  SingleValueFieldArray,
  useDirtyGuard,
} from '@exponetdb/ui-patterns'
import { zodResolver } from '@hookform/resolvers/zod'
import { type ReactNode, useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import type { DemoDefinition } from '../types.ts'

/** The slug grammar of an environment: lowercase letters, digits and dashes, starting with a letter. */
const environmentSchema = z.object({
  name: z
    .string()
    .min(1, 'Enter an environment name.')
    .regex(
      /^[a-z][a-z0-9-]*$/,
      'Use lowercase letters, digits and dashes, starting with a letter.',
    ),
  requireApproval: z.boolean(),
})
type EnvironmentValues = z.infer<typeof environmentSchema>

/** Shows the errors of the first validation at once, the way a form looks after a failed save. */
function useValidateOnMount(trigger: () => Promise<boolean>, enabled: boolean): void {
  useEffect(() => {
    if (enabled) void trigger()
  }, [trigger, enabled])
}

function EnvironmentForm({
  initialName,
  showErrors,
}: {
  initialName: string
  showErrors: boolean
}) {
  const form = useForm<EnvironmentValues>({
    resolver: zodResolver(environmentSchema),
    defaultValues: { name: initialName, requireApproval: true },
  })
  useValidateOnMount(form.trigger, showErrors)
  const [saved, setSaved] = useState<string | null>(null)
  return (
    <Form {...form}>
      <form
        className="flex max-w-xl flex-col gap-4"
        onSubmit={form.handleSubmit((values) => setSaved(values.name))}
      >
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItemLayout
              label="Environment name"
              description="The slug in the target path, such as staging."
            >
              <FormControl>
                <Input {...field} autoComplete="off" spellCheck={false} />
              </FormControl>
            </FormItemLayout>
          )}
        />
        <FormField
          control={form.control}
          name="requireApproval"
          render={({ field }) => (
            <FormItemLayout
              layout="flex-row-reverse"
              label="Require approval"
              description="Plans for this environment wait for a person other than their creator."
            >
              <FormControl>
                <Switch checked={field.value} onCheckedChange={field.onChange} />
              </FormControl>
            </FormItemLayout>
          )}
        />
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary">
            Save environment
          </Button>
          <span role="status" className="text-sm text-foreground-light">
            {saved === null ? '' : `Saved ${saved}.`}
          </span>
        </div>
      </form>
    </Form>
  )
}

const labelsSchema = z
  .object({ labels: z.array(z.object({ key: z.string(), value: z.string() })) })
  .superRefine((values, context) => {
    for (const issue of getKeyValueFieldArrayValidationIssues({
      rows: values.labels,
      keyFieldName: 'key',
      valueFieldName: 'value',
      keyRequiredMessage: 'Enter a label name.',
      valueRequiredMessage: 'Enter a label value.',
      duplicateKeyMessage: 'Label names must be unique.',
    })) {
      context.addIssue({ code: 'custom', path: ['labels', ...issue.path], message: issue.message })
    }
  })
type LabelValues = z.infer<typeof labelsSchema>

function LabelsForm({ rows, showErrors }: { rows: LabelValues['labels']; showErrors: boolean }) {
  const form = useForm<LabelValues>({
    resolver: zodResolver(labelsSchema),
    defaultValues: { labels: rows },
  })
  useValidateOnMount(form.trigger, showErrors)
  return (
    <Form {...form}>
      <form className="flex max-w-xl flex-col gap-4" onSubmit={form.handleSubmit(() => undefined)}>
        <KeyValueFieldArray
          control={form.control}
          name="labels"
          keyFieldName="key"
          valueFieldName="value"
          createEmptyRow={() => ({ key: '', value: '' })}
          keyPlaceholder="Label name"
          valuePlaceholder="Label value"
          addLabel="Add label"
          removeLabel="Remove label"
          aria-label="Labels"
        />
        <div>
          <Button type="submit" variant="primary">
            Save labels
          </Button>
        </div>
      </form>
    </Form>
  )
}

const rangesSchema = z.object({
  ranges: z.array(
    z.object({
      value: z
        .string()
        .min(1, 'Enter a range.')
        .regex(/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/, 'Use a CIDR range such as 10.20.0.0/16.'),
    }),
  ),
})
type RangeValues = z.infer<typeof rangesSchema>

function RangesForm() {
  const form = useForm<RangeValues>({
    resolver: zodResolver(rangesSchema),
    defaultValues: { ranges: [{ value: '10.20.0.0/16' }, { value: '10.30.4.0/24' }] },
  })
  return (
    <Form {...form}>
      <form className="flex max-w-xl flex-col gap-4" onSubmit={form.handleSubmit(() => undefined)}>
        <SingleValueFieldArray
          control={form.control}
          name="ranges"
          valueFieldName="value"
          createEmptyRow={() => ({ value: '' })}
          placeholder="10.20.0.0/16"
          valueLabel="Allowed range"
          addLabel="Add range"
          removeLabel="Remove range"
          aria-label="Allowed ranges"
          pasteSeparator={/[\s,]+/}
          minimumRows={1}
        />
        <div>
          <Button type="submit" variant="primary">
            Save ranges
          </Button>
        </div>
      </form>
    </Form>
  )
}

function DirtyGuardForm() {
  const form = useForm<{ description: string }>({
    defaultValues: { description: 'Orders and payments' },
  })
  const guard = useDirtyGuard({ when: form.formState.isDirty })
  const [log, setLog] = useState(
    'You are on the form. Change the text, then press "Leave the form".',
  )
  return (
    <Form {...form}>
      <form className="flex max-w-xl flex-col gap-4" onSubmit={(event) => event.preventDefault()}>
        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItemLayout label="Project description">
              <FormControl>
                <Input {...field} />
              </FormControl>
            </FormItemLayout>
          )}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              guard.requestLeave(
                () => {
                  form.reset()
                  setLog('You left the form. The changes were discarded.')
                },
                () => setLog('You kept editing.'),
              )
            }
          >
            Leave the form
          </Button>
          <span role="status" className="text-sm text-foreground-light">
            {log}
          </span>
        </div>
      </form>
      {guard.dialog}
    </Form>
  )
}

function Stack({ children }: { children: ReactNode }) {
  return <div className="flex max-w-xl flex-col gap-6">{children}</div>
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui-patterns/form-layout/layouts',
    title: 'Form layout without react-hook-form: vertical, horizontal and a row with a switch',
    render: () => (
      <Stack>
        <FormLayout
          label="Target name"
          labelOptional="Optional"
          description="Shown in lists. The target path is set by the registry."
        >
          {(control) => <Input {...control} defaultValue="Shop platform" />}
        </FormLayout>
        <FormLayout
          layout="horizontal"
          label="Lock timeout"
          description="How long a statement waits for a lock before it fails."
        >
          {(control) => <Input {...control} defaultValue="5 s" />}
        </FormLayout>
        <FormLayout
          layout="flex-row-reverse"
          label="Allow data reads by agents"
          description="Reads of production data by agents stay with a person by default."
        >
          {(control) => (
            <Switch
              id={control.id}
              aria-describedby={control['aria-describedby']}
              defaultChecked={false}
            />
          )}
        </FormLayout>
      </Stack>
    ),
  },
  {
    id: 'ui-patterns/form-layout/error',
    title:
      'Form layout with an error: announced, linked to the control, and the control is invalid',
    render: () => (
      <FormLayout
        label="Target name"
        description="Lowercase letters, digits and dashes."
        error="Use lowercase letters, digits and dashes, starting with a letter."
      >
        {(control) => <Input {...control} defaultValue="Shop Platform" />}
      </FormLayout>
    ),
  },
  {
    id: 'ui-patterns/form-item-layout/valid',
    title: 'Form item layout inside react-hook-form: a valid form that saves',
    render: () => <EnvironmentForm initialName="staging" showErrors={false} />,
  },
  {
    id: 'ui-patterns/form-item-layout/error',
    title: 'Form item layout after a failed validation: the message is the error of the field',
    render: () => <EnvironmentForm initialName="Staging Env" showErrors />,
  },
  {
    id: 'ui-patterns/key-value-field-array/labels',
    title: 'Key-value field array: add, remove and focus move with the keyboard',
    render: () => (
      <LabelsForm
        showErrors={false}
        rows={[
          { key: 'team', value: 'platform' },
          { key: 'owner', value: 'database operations' },
        ]}
      />
    ),
  },
  {
    id: 'ui-patterns/key-value-field-array/errors',
    title: 'Key-value field array with cell errors: a missing name and a repeated name',
    render: () => (
      <LabelsForm
        showErrors
        rows={[
          { key: 'team', value: 'platform' },
          { key: '', value: 'database operations' },
          { key: 'team', value: 'payments' },
        ]}
      />
    ),
  },
  {
    id: 'ui-patterns/single-value-field-array/ranges',
    title: 'Single-value field array: one value per row, paste a list to make one row each',
    render: () => <RangesForm />,
  },
  {
    id: 'ui-patterns/dirty-guard/leave',
    title: 'Dirty guard: leaving a changed form asks first, in the app, never in the browser',
    visual: false,
    render: () => <DirtyGuardForm />,
  },
]
