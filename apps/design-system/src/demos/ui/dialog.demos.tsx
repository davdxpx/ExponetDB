import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogSection,
  DialogSectionSeparator,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
} from '@exponetdb/ui'
import { type ReactNode, useId, useState } from 'react'
import type { DemoDefinition } from '../types.ts'
import { Row, Stack } from './support.tsx'

function Basic(): ReactNode {
  const id = useId()
  const [name, setName] = useState('Platform database')
  const [saved, setSaved] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  return (
    <Stack>
      <Row>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button variant="default">Rename target</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Rename target</DialogTitle>
              <DialogDescription>
                The display name changes. The path shop/platform/staging stays the same.
              </DialogDescription>
            </DialogHeader>
            <DialogSectionSeparator />
            <DialogSection>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={id} className="text-foreground-light">
                  Display name
                </Label>
                <Input id={id} value={name} onChange={(event) => setName(event.target.value)} />
              </div>
            </DialogSection>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="default">Cancel</Button>
              </DialogClose>
              <Button
                variant="primary"
                onClick={() => {
                  setSaved(name)
                  setOpen(false)
                }}
              >
                Save display name
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {saved === null ? null : (
          <p role="status" className="text-sm text-foreground-light">
            Saved: {saved}
          </p>
        )}
      </Row>
    </Stack>
  )
}

const SIZES = ['tiny', 'small', 'medium', 'large', 'xlarge'] as const
type DialogSize = (typeof SIZES)[number]

function Sizes(): ReactNode {
  const [size, setSize] = useState<DialogSize>('medium')
  const groupId = useId()
  return (
    <Stack>
      <div className="flex flex-col gap-2">
        <p id={groupId} className="text-sm font-medium text-foreground">
          Width of the dialog
        </p>
        <RadioGroup
          aria-labelledby={groupId}
          value={size}
          onValueChange={(next) => setSize(next as DialogSize)}
          className="flex flex-wrap gap-4"
        >
          {SIZES.map((option) => (
            <SizeOption key={option} option={option} />
          ))}
        </RadioGroup>
      </div>
      <div>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="default">Open the {size} dialog</Button>
          </DialogTrigger>
          <DialogContent size={size}>
            <DialogHeader>
              <DialogTitle>A {size} dialog</DialogTitle>
              <DialogDescription>Dialogs keep to one short task.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="default">Close</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </Stack>
  )
}

function SizeOption({ option }: { readonly option: DialogSize }): ReactNode {
  const id = useId()
  return (
    <div className="flex items-center gap-2">
      <RadioGroupItem id={id} value={option} />
      <Label htmlFor={id}>{option}</Label>
    </div>
  )
}

function Guarded(): ReactNode {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [asking, setAsking] = useState(false)
  const [note, setNote] = useState('')
  const dirty = note.trim() !== ''
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        onRequestClose={() => {
          if (!dirty) return true
          setAsking(true)
          return false
        }}
      >
        <DialogTrigger asChild>
          <Button variant="default">Add a note</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a note</DialogTitle>
            <DialogDescription>Type something, then press Escape.</DialogDescription>
          </DialogHeader>
          <DialogSection>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={id} className="text-foreground-light">
                Note
              </Label>
              <Input id={id} value={note} onChange={(event) => setNote(event.target.value)} />
            </div>
          </DialogSection>
          <DialogFooter>
            <Button
              variant="default"
              onClick={() => {
                if (dirty) setAsking(true)
                else setOpen(false)
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setNote('')
                setOpen(false)
              }}
            >
              Save note
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard changes?</AlertDialogTitle>
            <AlertDialogDescription>The note has not been saved.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              variant="danger"
              onClick={() => {
                setNote('')
                setOpen(false)
              }}
            >
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui/dialog/basic',
    title: 'A dialog with a form field and the actions in the footer',
    render: () => <Basic />,
    visual: false,
  },
  {
    id: 'ui/dialog/sizes',
    title: 'The five widths',
    render: () => <Sizes />,
    visual: false,
  },
  {
    id: 'ui/dialog/guarded',
    title: 'Closing a dirty dialog asks first, in the app',
    render: () => <Guarded />,
    visual: false,
  },
]
