import '@testing-library/jest-dom/vitest'
import { Toaster, toast } from '@exponetdb/ui'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { KeyValueList } from '../../src/records/key-value-list.tsx'
import { UntrustedName } from '../../src/untrusted/untrusted-name.tsx'
import { axeViolations } from '../support/axe.ts'

function installClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
}

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})

afterEach(() => {
  act(() => toast.clear())
  cleanup()
  vi.restoreAllMocks()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
})

describe('KeyValueList', () => {
  it('is a description list with one term and one definition per item', () => {
    const { container } = render(
      <KeyValueList
        items={[
          { id: 'a', label: 'Plan hash', value: 'sha256:abc' },
          { id: 'b', label: 'Tier', value: <strong>Production</strong> },
        ]}
      />,
    )

    expect(container.querySelector('dl')).not.toBeNull()
    expect(screen.getAllByRole('term').map((term) => term.textContent)).toEqual([
      'Plan hash',
      'Tier',
    ])
    const definitions = screen.getAllByRole('definition')
    expect(definitions[0]).toHaveTextContent('sha256:abc')
    expect(within(definitions[1] as HTMLElement).getByText('Production').tagName).toBe('STRONG')
  })

  it('renders an untrusted value only when the caller passes it through UntrustedName', () => {
    render(
      <KeyValueList
        items={[
          {
            id: 'a',
            label: 'Client',
            value: <UntrustedName name={'Cl\u{202E}ient'} unverified />,
          },
        ]}
      />,
    )

    expect(screen.getByText('⟨U+202E⟩')).toBeInTheDocument()
    expect(screen.getByText('name not verified')).toBeInTheDocument()
  })

  it('renders a plain string value as text', () => {
    const { container } = render(
      <KeyValueList items={[{ id: 'a', label: 'Note', value: '<b>not bold</b>' }]} />,
    )

    expect(container.querySelector('b')).toBeNull()
  })

  it('shows a copy button only for rows that offer one', () => {
    render(
      <KeyValueList
        items={[
          { id: 'a', label: 'Plan hash', value: 'sha256:abc', copyText: 'sha256:abc' },
          { id: 'b', label: 'Tier', value: 'Production' },
        ]}
      />,
    )

    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Copy Plan hash' })).toBeInTheDocument()
  })

  it('copies the text of the row and says so', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    installClipboard(writeText)
    render(
      <>
        <Toaster />
        <KeyValueList
          items={[{ id: 'a', label: 'Plan hash', value: 'sha256:ab…', copyText: 'sha256:abcdef' }]}
        />
      </>,
    )

    await user.click(screen.getByRole('button', { name: 'Copy Plan hash' }))

    expect(writeText).toHaveBeenCalledWith('sha256:abcdef')
    expect(await screen.findByText('Plan hash copied')).toBeInTheDocument()
  })

  it('says when the copy did not work', async () => {
    const user = userEvent.setup()
    installClipboard(vi.fn().mockRejectedValue(new Error('denied')))
    render(
      <>
        <Toaster />
        <KeyValueList items={[{ id: 'a', label: 'Plan hash', value: 'x', copyText: 'x' }]} />
      </>,
    )

    await user.click(screen.getByRole('button', { name: 'Copy Plan hash' }))

    expect(await screen.findByText('Could not copy to the clipboard')).toBeInTheDocument()
  })

  it('lays labels above values when stacked', () => {
    const { container } = render(
      <KeyValueList layout="stacked" items={[{ id: 'a', label: 'Tier', value: 'Production' }]} />,
    )

    expect(container.querySelector('dt')?.className).not.toContain('sm:w-44')
  })

  it('has no accessibility violations', async () => {
    const { container } = render(
      <KeyValueList
        items={[
          { id: 'a', label: 'Plan hash', value: 'sha256:abc', copyText: 'sha256:abc' },
          { id: 'b', label: 'Tier', value: 'Production' },
        ]}
      />,
    )

    expect(await axeViolations(container)).toEqual([])
  })
})
