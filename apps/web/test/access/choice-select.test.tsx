import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { type ChoiceQuery, ChoiceSelect } from '../../src/features/access/choice-select.tsx'
import { ApiError } from '../../src/lib/api/errors.ts'

afterEach(cleanup)

/**
 * The choice by name in front of a typed ID (a target, a product, ...): every
 * state of the read it stands on, shown truthfully (C-28). The component takes
 * the query's own fields, so each state is made the way a query produces it.
 */
interface Page {
  readonly items: readonly { readonly id: string; readonly path: string }[]
  readonly nextCursor: string | null
}

const ITEMS = [
  { id: 'tgt_01JZ0000000000000000000011', path: 'shop/app/production' },
  { id: 'tgt_01JZ0000000000000000000012', path: 'shop/app/staging' },
]

function query(over: Partial<ChoiceQuery<Page>>): ChoiceQuery<Page> {
  return {
    data: undefined,
    error: null,
    isError: false,
    dataUpdatedAt: Date.now(),
    isFetching: false,
    refetch: vi.fn(),
    ...over,
  }
}

function mount(read: ChoiceQuery<Page>, value = '', onChange: (value: string) => void = vi.fn()) {
  return render(
    <ChoiceSelect
      id="pick"
      label="Target"
      what="Target list"
      permission="targets.read"
      query={read}
      choices={(page) => page.items.map((item) => ({ value: item.id, label: item.path }))}
      placeholder="Choose a target"
      value={value}
      onChange={onChange}
    />,
  )
}

describe('a choice by name', () => {
  it('shows a loading read as loading and lets nothing be chosen, not as an empty list', async () => {
    const { container } = mount(query({}))
    expect(screen.getByLabelText('Target')).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Loading Target list')
    expect(screen.queryByText(/is empty/)).toBeNull()
    expect(await axeViolations(container)).toEqual([])
  })

  it('lists the entries of a complete read and reports the ID chosen', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const { container } = mount(query({ data: { items: ITEMS, nextCursor: null } }), '', onChange)
    expect(screen.getByLabelText('Target')).toBeEnabled()
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Choose a target',
      'shop/app/production',
      'shop/app/staging',
    ])
    // A complete read with entries says nothing else.
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    await user.selectOptions(screen.getByLabelText('Target'), ITEMS[1]?.id ?? '')
    expect(onChange).toHaveBeenCalledWith(ITEMS[1]?.id)
    expect(await axeViolations(container)).toEqual([])
  })

  it('shows the placeholder, not a wrong entry, for an ID the list does not hold', () => {
    mount(query({ data: { items: ITEMS, nextCursor: null } }), 'tgt_01JZ0000000000000000000099')
    expect(screen.getByLabelText('Target')).toHaveValue('')
  })

  it('shows a failed read as failed with the server’s text and a way to try again, never as an empty list', async () => {
    const user = userEvent.setup()
    const refetch = vi.fn()
    const { container } = mount(
      query({ error: new ApiError('INTERNAL', 500, 'The server failed.'), isError: true, refetch }),
    )
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Could not read Target list: The server failed. (INTERNAL)')
    expect(alert).toHaveTextContent(
      'This does not mean the list is empty. You can enter the ID instead.',
    )
    expect(screen.queryByText(/The read succeeded/)).toBeNull()
    expect(screen.getByLabelText('Target')).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(refetch).toHaveBeenCalledTimes(1)
    expect(await axeViolations(container)).toEqual([])
  })

  it('names the missing permission when the read is refused, and offers no retry', async () => {
    const { container } = mount(
      query({ error: new ApiError('PERMISSION_DENIED', 403, 'Not permitted.'), isError: true }),
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'You do not have access to Target list. It needs the permission targets.read.',
    )
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(await axeViolations(container)).toEqual([])
  })

  it('shows an earlier read as stale after a failed refresh, with the entries and a refresh', async () => {
    const user = userEvent.setup()
    const refetch = vi.fn()
    const { container } = mount(
      query({
        data: { items: ITEMS, nextCursor: null },
        error: new ApiError('INTERNAL', 500, 'The server failed.'),
        isError: true,
        refetch,
      }),
    )
    expect(screen.getByRole('status')).toHaveTextContent('Showing an earlier read of Target list.')
    expect(screen.getAllByRole('option')).toHaveLength(3)
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(refetch).toHaveBeenCalledTimes(1)
    expect(await axeViolations(container)).toEqual([])
  })

  it('shows an old read as stale even when nothing failed', () => {
    mount(
      query({
        data: { items: ITEMS, nextCursor: null },
        dataUpdatedAt: Date.now() - 10 * 60_000,
      }),
    )
    expect(screen.getByRole('status')).toHaveTextContent('Showing an earlier read of Target list.')
  })

  it('says a partial read lists only the first part, because the server has more', async () => {
    const { container } = mount(query({ data: { items: ITEMS, nextCursor: 'more' } }))
    expect(screen.getByRole('status')).toHaveTextContent(
      'Only the first 200 are listed. Enter the ID of any other one.',
    )
    expect(screen.getAllByRole('option')).toHaveLength(3)
    expect(await axeViolations(container)).toEqual([])
  })

  it('never calls a partial read empty, even when its first part holds nothing', () => {
    mount(query({ data: { items: [], nextCursor: 'more' } }))
    expect(screen.getByRole('status')).toHaveTextContent('Only the first 200 are listed')
    expect(screen.queryByText(/The read succeeded/)).toBeNull()
  })

  it('says a list is empty only after a successful read that found nothing', async () => {
    const { container } = mount(query({ data: { items: [], nextCursor: null } }))
    expect(screen.getByRole('status')).toHaveTextContent(
      'The read succeeded and Target list is empty. You can enter an ID if you know one.',
    )
    expect(await axeViolations(container)).toEqual([])
  })
})
