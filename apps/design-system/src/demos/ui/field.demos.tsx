import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
  Input,
  Switch,
  Textarea,
} from '@exponetdb/ui'
import { type ReactNode, useId } from 'react'
import type { DemoDefinition } from '../types.ts'

function Vertical(): ReactNode {
  const pathId = useId()
  const pathHint = useId()
  const reasonId = useId()
  return (
    <FieldSet className="max-w-md">
      <FieldLegend>Register a target</FieldLegend>
      <FieldDescription>
        The target is a database ExponetDB manages. It is not created.
      </FieldDescription>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={pathId}>Target path</FieldLabel>
          <Input id={pathId} aria-describedby={pathHint} placeholder="shop/platform/staging" />
          <FieldDescription id={pathHint}>Product, project and environment.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor={reasonId}>Reason (optional)</FieldLabel>
          <Textarea id={reasonId} />
        </Field>
      </FieldGroup>
    </FieldSet>
  )
}

function Horizontal(): ReactNode {
  const switchId = useId()
  return (
    <FieldGroup className="max-w-md">
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor={switchId}>Notify on failure</FieldLabel>
          <FieldDescription>Sends one message when an operation fails.</FieldDescription>
        </FieldContent>
        <Switch id={switchId} defaultChecked />
      </Field>
      <FieldSeparator>or</FieldSeparator>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldTitle>Audit export</FieldTitle>
          <FieldDescription>Set by policy. Ask an owner to change it.</FieldDescription>
        </FieldContent>
        <Switch aria-label="Audit export" disabled defaultChecked />
      </Field>
    </FieldGroup>
  )
}

function Invalid(): ReactNode {
  const id = useId()
  const errorId = useId()
  return (
    <Field data-invalid="true" className="max-w-md">
      <FieldLabel htmlFor={id}>Target path</FieldLabel>
      <Input id={id} aria-invalid="true" aria-describedby={errorId} defaultValue="Shop Platform" />
      <FieldError id={errorId}>Use lowercase letters, digits and hyphens.</FieldError>
    </Field>
  )
}

function Several(): ReactNode {
  const id = useId()
  const errorId = useId()
  return (
    <Field data-invalid="true" className="max-w-md">
      <FieldLabel htmlFor={id}>Environment slug</FieldLabel>
      <Input id={id} aria-invalid="true" aria-describedby={errorId} defaultValue="" />
      <FieldError
        id={errorId}
        errors={[
          { message: 'Enter the environment slug.' },
          { message: 'Use at most 40 characters.' },
        ]}
      />
    </Field>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui/field/vertical',
    title: 'A field set with a legend, a description and two fields',
    render: () => <Vertical />,
  },
  {
    id: 'ui/field/horizontal',
    title: 'Horizontal fields with a switch, and a separator',
    render: () => <Horizontal />,
  },
  { id: 'ui/field/invalid', title: 'A field with an error', render: () => <Invalid /> },
  {
    id: 'ui/field/several-errors',
    title: 'Several errors become a list',
    render: () => <Several />,
  },
]
