import { Checkbox, Label, Switch } from '@exponetdb/ui'
import { type ComponentProps, type ReactNode, useId, useState } from 'react'
import type { DemoDefinition } from '../types.ts'
import { Row, Stack } from './support.tsx'

function LabelledCheckbox({
  label,
  ...props
}: { readonly label: string } & Omit<ComponentProps<typeof Checkbox>, 'id'>): ReactNode {
  const id = useId()
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} {...props} />
      <Label htmlFor={id}>{label}</Label>
    </div>
  )
}

function Checkboxes(): ReactNode {
  return (
    <Stack>
      <LabelledCheckbox label="Include system schemas" />
      <LabelledCheckbox label="Verify after apply" defaultChecked />
      <LabelledCheckbox label="Some schemas included" checked="indeterminate" />
      <LabelledCheckbox label="Run in a maintenance window" disabled />
      <LabelledCheckbox label="Run in a maintenance window, chosen" disabled defaultChecked />
    </Stack>
  )
}

const SCHEMAS = ['public', 'billing', 'audit'] as const

function SelectAll(): ReactNode {
  const [chosen, setChosen] = useState<readonly string[]>(['public'])
  const all = chosen.length === SCHEMAS.length
  const some = chosen.length > 0 && !all
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-medium text-foreground">Schemas to compare</legend>
      <LabelledCheckbox
        label="All schemas"
        checked={all ? true : some ? 'indeterminate' : false}
        onCheckedChange={(next) => setChosen(next === true ? SCHEMAS : [])}
      />
      <div className="ml-6 flex flex-col gap-2">
        {SCHEMAS.map((schema) => (
          <LabelledCheckbox
            key={schema}
            label={schema}
            checked={chosen.includes(schema)}
            onCheckedChange={(next) =>
              setChosen((current) =>
                next === true ? [...current, schema] : current.filter((item) => item !== schema),
              )
            }
          />
        ))}
      </div>
    </fieldset>
  )
}

function Switches(): ReactNode {
  const smallId = useId()
  const mediumId = useId()
  const largeId = useId()
  const offId = useId()
  const lockedId = useId()
  return (
    <Stack>
      <Row>
        <Switch id={smallId} size="small" defaultChecked />
        <Label htmlFor={smallId}>Small</Label>
        <Switch id={mediumId} size="medium" defaultChecked />
        <Label htmlFor={mediumId}>Medium</Label>
        <Switch id={largeId} size="large" defaultChecked />
        <Label htmlFor={largeId}>Large</Label>
      </Row>
      <Row>
        <Switch id={offId} />
        <Label htmlFor={offId}>Notify on failure</Label>
      </Row>
      <Row>
        <Switch id={lockedId} disabled defaultChecked />
        <Label htmlFor={lockedId}>Audit export (set by policy)</Label>
      </Row>
    </Stack>
  )
}

function Choose(): ReactNode {
  const switchId = useId()
  const checkId = useId()
  const [saved, setSaved] = useState('Notifications are off.')
  return (
    <div className="grid gap-6 sm:grid-cols-2">
      <div className="flex flex-col gap-2 rounded-md border border-default p-4">
        <p className="text-xs font-medium text-foreground-light">A setting that applies at once</p>
        <div className="flex items-center gap-2">
          <Switch
            id={switchId}
            onCheckedChange={(next) =>
              setSaved(next ? 'Notifications are on.' : 'Notifications are off.')
            }
          />
          <Label htmlFor={switchId}>Notify on failure</Label>
        </div>
        <p role="status" className="text-xs text-foreground-lighter">
          {saved}
        </p>
      </div>
      <div className="flex flex-col gap-2 rounded-md border border-default p-4">
        <p className="text-xs font-medium text-foreground-light">An option in a form</p>
        <div className="flex items-center gap-2">
          <Checkbox id={checkId} />
          <Label htmlFor={checkId}>Include system schemas</Label>
        </div>
        <p className="text-xs text-foreground-lighter">Takes effect when you create the plan.</p>
      </div>
    </div>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui/checkbox-and-switch/checkbox',
    title: 'Checkbox: unchecked, checked, indeterminate and disabled',
    render: () => <Checkboxes />,
  },
  {
    id: 'ui/checkbox-and-switch/select-all',
    title: 'A select-all checkbox that is indeterminate while some are chosen',
    render: () => <SelectAll />,
  },
  {
    id: 'ui/checkbox-and-switch/switch',
    title: 'Switch: sizes, off and disabled',
    render: () => <Switches />,
  },
  {
    id: 'ui/checkbox-and-switch/choose',
    title: 'A switch applies at once, a checkbox waits for the form',
    render: () => <Choose />,
  },
]
