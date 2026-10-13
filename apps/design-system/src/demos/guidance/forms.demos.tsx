import {
  Button,
  Card,
  CardContent,
  CardFooter,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@exponetdb/ui'
import { FormLayout, useDirtyGuard } from '@exponetdb/ui-patterns'
import { type FormEvent, type ReactNode, useRef, useState } from 'react'
import type { DemoDefinition } from '../types.ts'
import { Outcome, wait } from './support.tsx'

// ---------------------------------------------------------------------------
// A settings card: one field per row, Save only while the form is dirty
// ---------------------------------------------------------------------------

interface PolicySettings {
  readonly approval: boolean
  readonly evidence: string
  readonly window: string
}

const SAVED_POLICY: PolicySettings = { approval: true, evidence: 'staging', window: '4' }

function windowError(value: string): string | undefined {
  return /^(?:[1-9]|1\d|2[0-4])$/.test(value) ? undefined : 'Enter a whole number from 1 to 24.'
}

function SettingsCard(): ReactNode {
  const [saved, setSaved] = useState<PolicySettings>(SAVED_POLICY)
  const [draft, setDraft] = useState<PolicySettings>(SAVED_POLICY)
  const [message, setMessage] = useState('')
  const windowField = useRef<HTMLInputElement>(null)
  const dirty =
    draft.approval !== saved.approval ||
    draft.evidence !== saved.evidence ||
    draft.window !== saved.window
  const error = windowError(draft.window)

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (error !== undefined) {
      // A failed submit moves focus to the first field with an error.
      windowField.current?.focus()
      return
    }
    setSaved(draft)
    setMessage('Policy saved.')
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Plan policy of the product shop">
      <Card>
        <CardContent>
          <FormLayout
            layout="flex-row-reverse"
            label="Require approval for agent plans"
            description="A person approves each plan an agent creates in this product before it can be applied."
          >
            {(control) => (
              <Switch
                {...control}
                checked={draft.approval}
                onCheckedChange={(approval) => {
                  setDraft({ ...draft, approval })
                  setMessage('')
                }}
              />
            )}
          </FormLayout>
        </CardContent>
        <CardContent>
          <FormLayout
            layout="flex-row-reverse"
            label="Evidence environment"
            description="Production applies a migration only after it was applied and verified here."
          >
            {(control) => (
              <Select
                value={draft.evidence}
                onValueChange={(evidence) => {
                  setDraft({ ...draft, evidence })
                  setMessage('')
                }}
              >
                <SelectTrigger {...control}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="staging">staging</SelectItem>
                  <SelectItem value="development">development</SelectItem>
                </SelectContent>
              </Select>
            )}
          </FormLayout>
        </CardContent>
        <CardContent>
          <FormLayout
            layout="flex-row-reverse"
            label="Approval window (hours)"
            description="From 1 to 24. A plan that waits longer for its approval is canceled."
            error={error}
          >
            {(control) => (
              <Input
                {...control}
                ref={windowField}
                inputMode="numeric"
                autoComplete="off"
                value={draft.window}
                onChange={(event) => {
                  setDraft({ ...draft, window: event.target.value })
                  setMessage('')
                }}
              />
            )}
          </FormLayout>
        </CardContent>
        <CardFooter className="justify-end gap-2">
          {dirty ? (
            <Button
              type="button"
              variant="default"
              onClick={() => {
                setDraft(saved)
                setMessage('')
              }}
            >
              Discard changes
            </Button>
          ) : null}
          <Button type="submit" variant="primary" disabled={!dirty}>
            Save policy
          </Button>
        </CardFooter>
      </Card>
      <Outcome>{message}</Outcome>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Validation: the error appears after the first blur, names the rule and the fix
// ---------------------------------------------------------------------------

function environmentNameError(value: string): string | undefined {
  if (value.length === 0) return 'Enter an environment name.'
  if (!/^[a-z0-9-]+$/.test(value)) return 'Use lowercase letters, digits and hyphens only.'
  if (value.length < 2 || value.length > 32) return 'Use 2 to 32 characters.'
  return undefined
}

function ValidationForm(): ReactNode {
  const [name, setName] = useState('Staging 2')
  // The field was left once, so its error shows. A new field shows none until it is left.
  const [touched, setTouched] = useState(true)
  const [message, setMessage] = useState('')
  const field = useRef<HTMLInputElement>(null)
  const error = environmentNameError(name)

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (error !== undefined) {
      field.current?.focus()
      setMessage('')
      return
    }
    setMessage('The form is valid. A real form would now create a plan; this demo changes nothing.')
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Add an environment" className="max-w-md">
      <div className="flex flex-col gap-4">
        <FormLayout
          layout="vertical"
          label="Environment name"
          description="Lowercase letters, digits and hyphens, 2 to 32 characters."
          error={touched ? error : undefined}
        >
          {(control) => (
            <Input
              {...control}
              ref={field}
              autoComplete="off"
              spellCheck={false}
              value={name}
              onBlur={() => setTouched(true)}
              onChange={(event) => {
                setName(event.target.value)
                setMessage('')
              }}
            />
          )}
        </FormLayout>
        <div>
          <Button type="submit" variant="primary">
            Add environment
          </Button>
        </div>
      </div>
      <Outcome>{message}</Outcome>
    </form>
  )
}

// ---------------------------------------------------------------------------
// A write-only field: typed once, cleared before it is sent, never shown again
// ---------------------------------------------------------------------------

const MIN_PASSWORD_LENGTH = 16

/** Stands in for the write-only endpoint: the demo keeps nothing and sends nothing. */
async function sendToWriteOnlyEndpoint(_secret: string): Promise<void> {
  await wait(400)
}

function WriteOnlyPassword(): ReactNode {
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [state, setState] = useState<'none' | 'sending' | 'pending'>('none')

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH
  const mismatch = confirmation.length > 0 && confirmation !== password
  const ready = password.length >= MIN_PASSWORD_LENGTH && password === confirmation

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!ready || state === 'sending') return
    // Both fields are emptied before anything is sent: nothing stays on the page.
    const secret = password
    setPassword('')
    setConfirmation('')
    setState('sending')
    await sendToWriteOnlyEndpoint(secret)
    setState('pending')
  }

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      aria-label="Password of the role reader"
      className="max-w-md"
    >
      <dl className="mb-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-foreground-light">Cluster</dt>
        <dd className="m-0 font-mono text-xs text-foreground">shop-main</dd>
        <dt className="text-foreground-light">Role</dt>
        <dd className="m-0 font-mono text-xs text-foreground">reader</dd>
        <dt className="text-foreground-light">Latest submission</dt>
        <dd className="m-0 text-foreground">
          {state === 'none' ? 'None yet' : 'Pending verification'}
        </dd>
      </dl>
      <div className="flex flex-col gap-4">
        <FormLayout
          layout="vertical"
          label="Password"
          description={`At least ${MIN_PASSWORD_LENGTH} characters. It cannot be shown again after you send it.`}
          error={tooShort ? `Use at least ${MIN_PASSWORD_LENGTH} characters.` : undefined}
        >
          {(control) => (
            <Input
              {...control}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          )}
        </FormLayout>
        <FormLayout
          layout="vertical"
          label="Repeat the password"
          error={mismatch ? 'The two passwords differ.' : undefined}
        >
          {(control) => (
            <Input
              {...control}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          )}
        </FormLayout>
        <div>
          <Button type="submit" variant="primary" loading={state === 'sending'} disabled={!ready}>
            Send password
          </Button>
        </div>
      </div>
      <Outcome>
        {state === 'pending'
          ? 'Password sent. ExponetDB checks the login before it uses the password.'
          : ''}
      </Outcome>
    </form>
  )
}

// ---------------------------------------------------------------------------
// The dirty guard: leaving a form with unsaved changes asks first, in the app
// ---------------------------------------------------------------------------

function DirtyGuardForm(): ReactNode {
  const [baseline, setBaseline] = useState('Shop platform')
  const [value, setValue] = useState(baseline)
  const [leaves, setLeaves] = useState<readonly string[]>([])
  const dirty = value !== baseline
  const guard = useDirtyGuard({ when: dirty })

  const leave = () =>
    guard.requestLeave(() => {
      setLeaves((previous) => [
        ...previous,
        dirty ? 'Left the form. The unsaved change was discarded.' : 'Left the form.',
      ])
      setValue(baseline)
    })

  return (
    <form
      noValidate
      aria-label="Display name of the product"
      className="max-w-md"
      onSubmit={(event) => {
        event.preventDefault()
        setBaseline(value)
      }}
    >
      <FormLayout
        layout="vertical"
        label="Display name"
        description="Shown in lists. The target path does not change."
      >
        {(control) => (
          <Input
            {...control}
            autoComplete="off"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        )}
      </FormLayout>
      <div className="mt-4 flex gap-2">
        <Button type="submit" variant="primary" disabled={!dirty}>
          Save display name
        </Button>
        <Button type="button" variant="default" onClick={leave}>
          Back to databases
        </Button>
      </div>
      <Outcome>{leaves.at(-1) ?? ''}</Outcome>
      {guard.dialog}
    </form>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'guidance/forms/settings-card',
    title: 'A settings form in a card: change a value and Save becomes available',
    render: () => <SettingsCard />,
  },
  {
    id: 'guidance/forms/validation',
    title: 'A field error names the rule and how to fix it',
    render: () => <ValidationForm />,
  },
  {
    id: 'guidance/forms/write-only-password',
    title: 'A write-only password: typed twice, cleared before it is sent',
    render: () => <WriteOnlyPassword />,
  },
  {
    id: 'guidance/forms/dirty-guard',
    title: 'Leaving a form with unsaved changes asks first',
    render: () => <DirtyGuardForm />,
  },
]
