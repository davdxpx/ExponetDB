import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  apiKey,
  mountApp,
  oauthClient,
  SECRET,
  serviceAccount,
  targetItem,
  World,
} from './support.tsx'

afterEach(cleanup)

const tid = (n: number): string => `tgt_01JZ${String(n).padStart(22, '0')}`
const BIDI = `admin${String.fromCodePoint(0x202e)}gpj.exe`
const HOSTILE = '<script>document.title="x"</script><img src=x onerror=alert(1)>'

function card(name: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('li[data-service]')].find((li) =>
    li.querySelector('h2')?.textContent?.includes(name),
  )
  if (found === undefined) throw new Error(`no card for ${name}`)
  return found
}

/** The part of a card that holds one authority form: "API keys" or "Machine grant". */
function part(name: string, heading: string): HTMLElement {
  const section = [...card(name).querySelectorAll<HTMLElement>('section')].find(
    (s) => s.querySelector('h3')?.textContent === heading,
  )
  if (section === undefined) throw new Error(`no section ${heading}`)
  return section
}

function worldWith(...targets: ReturnType<typeof targetItem>[]): World {
  const world = new World()
  world.accounts = [serviceAccount()]
  world.targets = targets
  return world
}

const PROD = targetItem({ id: tid(1), path: 'shop/app/production', tier: 'prod' })
const STAGING = targetItem({ id: tid(2), path: 'shop/app/staging', tier: 'nonprod' })

async function openKeyForm(): Promise<HTMLElement> {
  const user = userEvent.setup()
  await waitFor(() => expect(card('Nightly checks')).toBeInTheDocument())
  const keys = part('Nightly checks', 'API keys')
  await user.click(within(keys).getByRole('button', { name: 'Change scopes and limits' }))
  return keys
}

describe('limiting an API key or a machine grant to targets', () => {
  it('defaults to all targets and says so next to the button, without any registry read', async () => {
    const world = worldWith(PROD, STAGING)
    mountApp('/access/service-accounts', world)
    await waitFor(() => expect(card('Nightly checks')).toBeInTheDocument())
    expect(card('Nightly checks').textContent).toContain(
      'Scopes: targets.read. Tiers: Non-production. Lifetime: 90 days. Targets: all the roles reach.',
    )
    const keys = await openKeyForm()
    expect(within(keys).getByLabelText('Limit to targets')).toHaveValue('all')
    expect(world.requests.filter((r) => r.path.startsWith('/api/v1/targets'))).toHaveLength(0)
  })

  it('warns in words, not as an error, when production is allowed for all targets', async () => {
    const user = userEvent.setup()
    const world = worldWith(PROD, STAGING)
    const { container } = mountApp('/access/service-accounts', world)
    const keys = await openKeyForm()
    expect(within(keys).queryByText(/Production is allowed for every target/)).toBeNull()
    await user.click(within(keys).getByRole('checkbox', { name: 'Production' }))
    const warning = within(keys).getByText(
      'Production is allowed for every target the roles reach. Limit it to the targets it needs.',
    )
    expect(warning).toBeInTheDocument()
    expect(warning.closest('[role="alert"]')).toBeNull()
    expect(await axeViolations(container)).toEqual([])

    // It does not stop the request: the roles remain the ceiling.
    await user.click(within(keys).getByRole('button', { name: 'Create API key' }))
    await screen.findByText(SECRET)
    expect(world.changes).toHaveLength(1)
    expect(world.changes[0]?.body).toMatchObject({
      restrictions: { tiers: ['nonprod', 'prod'], targets: { kind: 'all' } },
    })
  })

  it('takes the warning away once the key is limited to named targets', async () => {
    const user = userEvent.setup()
    const world = worldWith(PROD, STAGING)
    mountApp('/access/service-accounts', world)
    const keys = await openKeyForm()
    await user.click(within(keys).getByRole('checkbox', { name: 'Production' }))
    expect(within(keys).getByText(/Production is allowed for every target/)).toBeInTheDocument()
    await user.selectOptions(within(keys).getByLabelText('Limit to targets'), 'list')
    expect(within(keys).queryByText(/Production is allowed for every target/)).toBeNull()
  })

  it('lists the targets only once "only the targets I choose" is picked, with their paths and tiers', async () => {
    const user = userEvent.setup()
    const world = worldWith(PROD, STAGING)
    const { container } = mountApp('/access/service-accounts', world)
    const keys = await openKeyForm()
    await user.selectOptions(within(keys).getByLabelText('Limit to targets'), 'list')
    const prod = await within(keys).findByRole('checkbox', { name: /shop\/app\/production/ })
    const staging = within(keys).getByRole('checkbox', { name: /shop\/app\/staging/ })
    expect(prod).not.toBeChecked()
    expect(within(keys).getByText('0 of 64 targets chosen.')).toBeInTheDocument()
    expect(keys.querySelector('[data-tier="production"]')).not.toBeNull()
    await user.click(prod)
    await user.click(staging)
    expect(within(keys).getByText('2 of 64 targets chosen.')).toBeInTheDocument()
    expect(card('Nightly checks').textContent).toContain('Targets: only the 2 chosen.')
    expect(await axeViolations(container)).toEqual([])
  })

  it('sends the chosen target IDs, once each, and refuses an empty choice before any request', async () => {
    const user = userEvent.setup()
    const world = worldWith(PROD, STAGING)
    mountApp('/access/service-accounts', world)
    const keys = await openKeyForm()
    await user.selectOptions(within(keys).getByLabelText('Limit to targets'), 'list')
    await within(keys).findByRole('checkbox', { name: /shop\/app\/production/ })

    await user.click(within(keys).getByRole('button', { name: 'Create API key' }))
    expect(
      await within(keys).findByText('Choose from 1 to 64 targets, or allow all targets.'),
    ).toBeInTheDocument()
    expect(world.changes).toEqual([])

    await user.click(within(keys).getByRole('checkbox', { name: /shop\/app\/staging/ }))
    await user.click(within(keys).getByRole('checkbox', { name: /shop\/app\/production/ }))
    await user.click(within(keys).getByRole('button', { name: 'Create API key' }))
    await screen.findByText(SECRET)
    expect(world.changes[0]?.body).toEqual({
      scopes: ['targets.read'],
      restrictions: { tiers: ['nonprod'], targets: { kind: 'list', targetIds: [tid(2), tid(1)] } },
      lifetimeDays: 90,
    })
  })

  it('limits a machine grant too', async () => {
    const user = userEvent.setup()
    const world = worldWith(PROD, STAGING)
    world.accounts = [
      serviceAccount({
        client: oauthClient({ registration: 'pre_registered', kind: 'ci', state: 'active' }),
      }),
    ]
    mountApp('/access/service-accounts', world)
    await waitFor(() => expect(card('Nightly checks')).toBeInTheDocument())
    const grants = part('Nightly checks', 'Machine grant')
    await user.click(within(grants).getByRole('button', { name: 'Change scopes and limits' }))
    await user.selectOptions(within(grants).getByLabelText('Limit to targets'), 'list')
    await user.click(await within(grants).findByRole('checkbox', { name: /shop\/app\/staging/ }))
    await user.click(within(grants).getByRole('button', { name: 'Create machine grant' }))
    await waitFor(() => expect(world.changes).toHaveLength(1))
    expect(world.changes[0]?.body).toMatchObject({
      restrictions: { targets: { kind: 'list', targetIds: [tid(2)] } },
    })
  })

  it('stops at 64 targets and says so', { timeout: 60_000 }, async () => {
    const user = userEvent.setup()
    const many = Array.from({ length: 65 }, (_, index) =>
      targetItem({ id: tid(index + 1), path: `shop/app/env-${index + 1}`, tier: 'nonprod' }),
    )
    const world = worldWith(...many)
    mountApp('/access/service-accounts', world)
    const keys = await openKeyForm()
    await user.selectOptions(within(keys).getByLabelText('Limit to targets'), 'list')
    await within(keys).findByRole('checkbox', { name: /env-1\s*Non-production$/ })
    // Role queries over 65 entries are slow; the entries are read from the list itself.
    const boxes = (): HTMLElement[] => [
      ...keys.querySelectorAll<HTMLElement>('[data-target-checklist] ul button[role="checkbox"]'),
    ]
    expect(boxes()).toHaveLength(65)
    for (const box of boxes().slice(0, 64)) fireEvent.click(box)
    expect(await within(keys).findByText('64 of 64 targets chosen.')).toBeInTheDocument()
    expect(boxes()[64]).toBeDisabled()
    expect(within(keys).getByText('At most 64 targets can be chosen.')).toBeInTheDocument()
    // A checked one can still be unchecked.
    expect(boxes()[0]).toBeEnabled()
    fireEvent.click(boxes()[0] as HTMLElement)
    expect(await within(keys).findByText('63 of 64 targets chosen.')).toBeInTheDocument()
    expect(boxes()[64]).toBeEnabled()
  })

  it('narrows the list by a search, and says "No match" with a way back when nothing fits', async () => {
    const user = userEvent.setup()
    const world = worldWith(PROD, STAGING)
    mountApp('/access/service-accounts', world)
    const keys = await openKeyForm()
    await user.selectOptions(within(keys).getByLabelText('Limit to targets'), 'list')
    await within(keys).findByRole('checkbox', { name: /shop\/app\/production/ })
    fireEvent.change(within(keys).getByLabelText('Search targets'), { target: { value: 'stag' } })
    expect(within(keys).queryByRole('checkbox', { name: /shop\/app\/production/ })).toBeNull()
    expect(within(keys).getByRole('checkbox', { name: /shop\/app\/staging/ })).toBeInTheDocument()
    fireEvent.change(within(keys).getByLabelText('Search targets'), { target: { value: 'zzz' } })
    expect(
      within(keys).getByText(/No match\. No listed target fits this search\./),
    ).toBeInTheDocument()
    await user.click(within(keys).getByRole('button', { name: 'Clear search' }))
    expect(within(keys).getAllByRole('checkbox', { name: /shop\/app/ })).toHaveLength(2)
  })

  it('adds a target by its ID, checks the shape, and shows one the list does not hold until it is removed', async () => {
    const user = userEvent.setup()
    const world = worldWith(PROD)
    mountApp('/access/service-accounts', world)
    const keys = await openKeyForm()
    await user.selectOptions(within(keys).getByLabelText('Limit to targets'), 'list')
    await within(keys).findByRole('checkbox', { name: /shop\/app\/production/ })

    fireEvent.change(within(keys).getByLabelText('Add a target by its ID'), {
      target: { value: 'tgt_bad' },
    })
    await user.click(within(keys).getByRole('button', { name: 'Add target' }))
    expect(
      await within(keys).findByText(/Enter an ID that starts with tgt_ followed by 26/),
    ).toBeInTheDocument()
    expect(within(keys).getByText('0 of 64 targets chosen.')).toBeInTheDocument()

    const unlisted = tid(99)
    fireEvent.change(within(keys).getByLabelText('Add a target by its ID'), {
      target: { value: unlisted },
    })
    await user.click(within(keys).getByRole('button', { name: 'Add target' }))
    expect(within(keys).getByText('1 of 64 targets chosen.')).toBeInTheDocument()
    expect(within(keys).getByText('Chosen, but not in the list above:')).toBeInTheDocument()
    await user.click(within(keys).getByRole('button', { name: `Remove target ${unlisted}` }))
    expect(within(keys).getByText('0 of 64 targets chosen.')).toBeInTheDocument()
  })

  it('points out a chosen target whose tier the authority does not include', async () => {
    const user = userEvent.setup()
    const world = worldWith(PROD, STAGING)
    mountApp('/access/service-accounts', world)
    const keys = await openKeyForm()
    await user.selectOptions(within(keys).getByLabelText('Limit to targets'), 'list')
    await user.click(await within(keys).findByRole('checkbox', { name: /shop\/app\/production/ }))
    expect(
      within(keys).getByText(
        'shop/app/production is Production, but that tier is not chosen above, so this authority cannot use it.',
      ),
    ).toBeInTheDocument()
  })

  it('says a failed target read failed, never an empty registry, and an ID can still be added', async () => {
    const user = userEvent.setup()
    const world = worldWith(PROD)
    world.failures.set('GET /api/v1/targets', {
      status: 500,
      code: 'INTERNAL',
      message: 'The server failed.',
    })
    mountApp('/access/service-accounts', world)
    const keys = await openKeyForm()
    await user.selectOptions(within(keys).getByLabelText('Limit to targets'), 'list')
    expect(await within(keys).findByText(/Could not read Target list/)).toBeInTheDocument()
    expect(within(keys).queryByText(/The read succeeded/)).toBeNull()
    expect(within(keys).queryByRole('checkbox', { name: /shop/ })).toBeNull()
    fireEvent.change(within(keys).getByLabelText('Add a target by its ID'), {
      target: { value: tid(1) },
    })
    await user.click(within(keys).getByRole('button', { name: 'Add target' }))
    await user.click(within(keys).getByRole('button', { name: 'Create API key' }))
    await screen.findByText(SECRET)
    expect(world.changes[0]?.body).toMatchObject({
      restrictions: { targets: { kind: 'list', targetIds: [tid(1)] } },
    })
  })

  it('says a cut target list is partial, and an empty one empty only after a successful read', async () => {
    const user = userEvent.setup()
    const world = worldWith(PROD)
    world.cursors.set('/api/v1/targets', 'more')
    mountApp('/access/service-accounts', world)
    let keys = await openKeyForm()
    await user.selectOptions(within(keys).getByLabelText('Limit to targets'), 'list')
    expect(await within(keys).findByText(/Only the first 200 are listed/)).toBeInTheDocument()
    cleanup()

    const empty = worldWith()
    mountApp('/access/service-accounts', empty)
    keys = await openKeyForm()
    await user.selectOptions(within(keys).getByLabelText('Limit to targets'), 'list')
    expect(
      await within(keys).findByText(/The read succeeded and Target list is empty/),
    ).toBeInTheDocument()
  })

  it('shows hostile target paths as text with hidden characters named', async () => {
    const user = userEvent.setup()
    const world = worldWith(
      targetItem({ id: tid(1), path: `shop/${BIDI}${HOSTILE}`, tier: 'prod' }),
    )
    const { container } = mountApp('/access/service-accounts', world)
    const keys = await openKeyForm()
    await user.selectOptions(within(keys).getByLabelText('Limit to targets'), 'list')
    const label = await waitFor(() => {
      const found = keys.querySelector('[data-target-checklist] ul label')
      if (found === null) throw new Error('no target yet')
      return found
    })
    expect(label.textContent).toContain('⟨U+202E⟩')
    expect(label.textContent).toContain('<script>')
    // The sentence that points out a tier mismatch names the path as plain text, hidden characters by code point.
    await user.click(
      keys.querySelector('[data-target-checklist] ul button[role="checkbox"]') as Element,
    )
    const note = await waitFor(() => {
      const found = [...keys.querySelectorAll('li')].find((li) =>
        li.textContent?.includes('is Production'),
      )
      if (found === undefined) throw new Error('no note yet')
      return found
    })
    expect(note.textContent).toContain('⟨U+202E⟩')
    expect(note.textContent).not.toContain(String.fromCodePoint(0x202e))
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
  })
})

describe('the restriction of keys and grants in the lists', () => {
  it('shows where each key and grant may act, and keeps the line the browser suite selects on', async () => {
    const world = new World()
    world.accounts = [
      serviceAccount({
        apiKeys: [
          apiKey({ id: 'key_01JZ0000000000000000000011' }),
          apiKey({
            id: 'key_01JZ0000000000000000000012',
            restrictions: { tiers: ['prod'], targets: { kind: 'list', targetIds: [tid(1)] } },
          }),
          apiKey({
            id: 'key_01JZ0000000000000000000013',
            restrictions: {
              tiers: ['nonprod', 'prod'],
              targets: { kind: 'list', targetIds: [tid(1), tid(2), tid(3), tid(4), tid(5)] },
            },
          }),
        ],
      }),
    ]
    mountApp('/access/service-accounts', world)
    await waitFor(() => expect(card('Nightly checks')).toBeInTheDocument())
    const row = (id: string): HTMLElement => {
      const found = [...card('Nightly checks').querySelectorAll('li')].find((li) =>
        li.textContent?.includes(id),
      )
      if (found === undefined) throw new Error(`no row ${id}`)
      return found
    }
    expect(row('key_01JZ0000000000000000000011').textContent).toContain(
      'targets.read, active, until',
    )
    expect(row('key_01JZ0000000000000000000011').textContent).toContain(
      'Tiers: Non-production. Targets: all the roles reach.',
    )
    expect(row('key_01JZ0000000000000000000012').textContent).toContain(
      `Tiers: Production. Targets: limited to 1 target (${tid(1)}).`,
    )
    expect(row('key_01JZ0000000000000000000013').textContent).toContain(
      `Targets: limited to 5 targets (${tid(1)}, ${tid(2)}, ${tid(3)}, and 2 more).`,
    )
  })
})
