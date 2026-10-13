import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetSection,
  SheetTitle,
  Textarea,
} from '@exponetdb/ui'
import { FormLayout, useDirtyGuard } from '@exponetdb/ui-patterns'
import { type FormEvent, type ReactNode, useId, useState } from 'react'
import type { DemoDefinition } from '../types.ts'
import { Outcome } from './support.tsx'

/**
 * Both overlays follow the same rule: every way out (Escape, the overlay, the close icon and
 * Cancel) goes through one guard. A clean form closes at once; a dirty one asks first.
 */

function RegisterProductSheet(): ReactNode {
  const formId = useId()
  const [open, setOpen] = useState(false)
  const [slug, setSlug] = useState('')
  const [label, setLabel] = useState('')
  const [notes, setNotes] = useState('')
  const [message, setMessage] = useState('')
  const dirty = slug !== '' || label !== '' || notes !== ''
  const guard = useDirtyGuard({ when: dirty })

  const reset = () => {
    setSlug('')
    setLabel('')
    setNotes('')
  }
  const close = () => {
    setOpen(false)
    reset()
  }
  // Escape, the overlay and the close icon end here; returning false keeps the sheet open.
  const onRequestClose = () => {
    if (!dirty) return undefined
    guard.requestLeave(close)
    return false
  }
  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (slug === '') return
    setMessage(`Plan created for the product ${slug}. Nothing changes until it is applied.`)
    close()
  }

  return (
    <div>
      <Button variant="default" onClick={() => setOpen(true)}>
        Register product
      </Button>
      <Outcome>{message}</Outcome>
      <Sheet open={open} onOpenChange={setOpen} onRequestClose={onRequestClose}>
        <SheetContent size="default">
          <SheetHeader>
            <SheetTitle>Register a product</SheetTitle>
            <SheetDescription>
              Creates a plan. Nothing changes until the plan is reviewed and applied.
            </SheetDescription>
          </SheetHeader>
          <SheetSection>
            <form id={formId} onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
              <FormLayout
                layout="vertical"
                label="Product slug"
                description="Lowercase letters, digits and hyphens."
              >
                {(control) => (
                  <Input
                    {...control}
                    autoComplete="off"
                    spellCheck={false}
                    value={slug}
                    onChange={(event) => setSlug(event.target.value)}
                  />
                )}
              </FormLayout>
              <FormLayout layout="vertical" label="Display name" labelOptional="Optional">
                {(control) => (
                  <Input
                    {...control}
                    autoComplete="off"
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                  />
                )}
              </FormLayout>
              <FormLayout layout="vertical" label="Notes" labelOptional="Optional">
                {(control) => (
                  <Textarea
                    {...control}
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                  />
                )}
              </FormLayout>
            </form>
          </SheetSection>
          <SheetFooter>
            <Button type="button" variant="default" onClick={() => guard.requestLeave(close)}>
              Cancel
            </Button>
            <Button type="submit" form={formId} variant="primary">
              Create plan
            </Button>
          </SheetFooter>
        </SheetContent>
        {guard.dialog}
      </Sheet>
    </div>
  )
}

function RenameDialog(): ReactNode {
  const formId = useId()
  const saved = 'Shop platform'
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(saved)
  const [message, setMessage] = useState('')
  const dirty = name !== saved
  const guard = useDirtyGuard({ when: dirty })

  const close = () => {
    setOpen(false)
    setName(saved)
  }
  const onRequestClose = () => {
    if (!dirty) return undefined
    guard.requestLeave(close)
    return false
  }
  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    setMessage(`Display name changed to ${name}.`)
    setOpen(false)
  }

  return (
    <div>
      <Button variant="default" onClick={() => setOpen(true)}>
        Rename project
      </Button>
      <Outcome>{message}</Outcome>
      <Dialog open={open} onOpenChange={setOpen} onRequestClose={onRequestClose}>
        <DialogContent size="small">
          <DialogHeader>
            <DialogTitle>Rename the project</DialogTitle>
            <DialogDescription>
              Only the display name changes, not the target path.
            </DialogDescription>
          </DialogHeader>
          <form id={formId} onSubmit={onSubmit} noValidate className="px-4 pb-4 md:px-5">
            <FormLayout layout="vertical" label="Display name">
              {(control) => (
                <Input
                  {...control}
                  autoComplete="off"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              )}
            </FormLayout>
          </form>
          <DialogFooter>
            <Button type="button" variant="default" onClick={() => guard.requestLeave(close)}>
              Cancel
            </Button>
            <Button type="submit" form={formId} variant="primary" disabled={!dirty}>
              Save display name
            </Button>
          </DialogFooter>
        </DialogContent>
        {guard.dialog}
      </Dialog>
    </div>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'guidance/modality/sheet-with-form',
    title: 'A sheet for a longer form: every way out asks before it discards',
    visual: false,
    render: () => <RegisterProductSheet />,
  },
  {
    id: 'guidance/modality/dialog-with-field',
    title: 'A dialog for one short task, with the same guard',
    visual: false,
    render: () => <RenameDialog />,
  },
]
