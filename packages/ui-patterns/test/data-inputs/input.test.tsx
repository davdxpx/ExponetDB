import '@testing-library/jest-dom/vitest'
import { Toaster, toast } from '@exponetdb/ui'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DataInput } from '../../src/data-inputs/input.tsx'
import { axeViolations } from '../support/axe.ts'

function installClipboard(writeText: ReturnType<typeof vi.fn> | undefined) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: writeText === undefined ? undefined : { writeText },
  })
}

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})

afterEach(() => {
  cleanup()
  act(() => toast.clear())
  vi.restoreAllMocks()
  installClipboard(undefined)
})

describe('DataInput', () => {
  it('renders an input with its accessible name and value, and no violations', async () => {
    const { container } = render(
      <DataInput aria-label="Plan hash" defaultValue="sha256:pl1:3f2a" readOnly copy />,
    )

    expect(screen.getByRole('textbox', { name: 'Plan hash' })).toHaveValue('sha256:pl1:3f2a')
    expect(await axeViolations(container)).toEqual([])
  })

  it('copies the value, says so in a toast and on the button, and calls onCopied', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    installClipboard(writeText)
    const onCopied = vi.fn()
    render(
      <>
        <DataInput
          aria-label="Plan hash"
          defaultValue="sha256:pl1:3f2a"
          readOnly
          copy
          onCopied={onCopied}
        />
        <Toaster />
      </>,
    )

    await user.click(screen.getByRole('button', { name: 'Copy Plan hash' }))

    expect(writeText).toHaveBeenCalledWith('sha256:pl1:3f2a')
    expect(onCopied).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Copied to the clipboard')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copied Plan hash' })).toHaveTextContent('Copied')
  })

  it('copies the text the person typed, also for an uncontrolled input', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    installClipboard(writeText)
    render(<DataInput aria-label="Host" copy />)

    await user.type(screen.getByRole('textbox', { name: 'Host' }), 'db.example.test')
    await user.click(screen.getByRole('button', { name: 'Copy Host' }))

    expect(writeText).toHaveBeenCalledWith('db.example.test')
  })

  it('reports a copy that failed instead of claiming success', async () => {
    const user = userEvent.setup()
    installClipboard(vi.fn().mockRejectedValue(new Error('denied')))
    const onCopied = vi.fn()
    render(
      <>
        <DataInput
          aria-label="Host"
          defaultValue="db.example.test"
          readOnly
          copy
          onCopied={onCopied}
        />
        <Toaster />
      </>,
    )

    await user.click(screen.getByRole('button', { name: 'Copy Host' }))

    expect(await screen.findByText('Could not copy to the clipboard')).toBeInTheDocument()
    expect(onCopied).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Copy Host' })).toHaveTextContent('Copy')
  })

  it('says so when there is nothing to copy', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    installClipboard(writeText)
    render(
      <>
        <DataInput aria-label="Host" copy />
        <Toaster />
      </>,
    )

    await user.click(screen.getByRole('button', { name: 'Copy Host' }))

    expect(writeText).not.toHaveBeenCalled()
    expect(await screen.findByText('There is nothing to copy')).toBeInTheDocument()
  })

  it('has no reveal control and no copy button for a password', () => {
    render(<DataInput aria-label="Role password" type="password" defaultValue="s3cr3t" copy />)

    expect(screen.getByLabelText('Role password')).toHaveAttribute('type', 'password')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByText(/reveal/i)).not.toBeInTheDocument()
  })

  it('selects a displayed value on focus but leaves an editable one alone', async () => {
    const user = userEvent.setup()
    render(
      <>
        <DataInput aria-label="Read only" defaultValue="abcdef" readOnly />
        <DataInput aria-label="Editable" defaultValue="abcdef" />
      </>,
    )

    const readOnly = screen.getByRole<HTMLInputElement>('textbox', { name: 'Read only' })
    await user.click(readOnly)
    expect(readOnly.selectionStart).toBe(0)
    expect(readOnly.selectionEnd).toBe(6)

    const editable = screen.getByRole<HTMLInputElement>('textbox', { name: 'Editable' })
    await user.click(editable)
    expect(editable.selectionEnd).not.toBe(0)
    expect(editable.selectionStart).toBe(editable.selectionEnd)
  })

  it('calls the caller onFocus and forwards the ref to the input', async () => {
    const user = userEvent.setup()
    const onFocus = vi.fn()
    const ref = createRef<HTMLInputElement>()
    render(<DataInput aria-label="Host" ref={ref} onFocus={onFocus} />)

    await user.click(screen.getByRole('textbox', { name: 'Host' }))

    expect(onFocus).toHaveBeenCalledTimes(1)
    expect(ref.current).toBe(screen.getByRole('textbox', { name: 'Host' }))
  })

  it('renders the actions and the icon, and keeps a disabled input from copying', () => {
    render(
      <DataInput
        aria-label="Host"
        defaultValue="db.example.test"
        disabled
        copy
        icon={<span data-testid="icon">i</span>}
        actions={<button type="button">Refresh</button>}
      />,
    )

    expect(screen.getByTestId('icon')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy Host' })).toBeDisabled()
  })

  it('shows a value that is data as text', () => {
    render(<DataInput aria-label="Name" defaultValue="<img src=x onerror=alert(1)>" readOnly />)

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue(
      '<img src=x onerror=alert(1)>',
    )
    expect(document.querySelector('img')).toBeNull()
  })
})
