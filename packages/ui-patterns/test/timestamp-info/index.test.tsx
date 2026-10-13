import '@testing-library/jest-dom/vitest'
import { Toaster, TooltipProvider, toast } from '@exponetdb/ui'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TimestampInfo, TimestampInfoProvider } from '../../src/timestamp-info/index.tsx'
import { axeViolations } from '../support/axe.ts'

afterEach(() => {
  act(() => toast.clear())
  cleanup()
  vi.restoreAllMocks()
})

const NOW = '2026-10-13T14:07:22Z'
const INSTANT = '2026-10-13T14:03:22Z'

function renderInfo(ui: React.ReactNode) {
  const user = userEvent.setup()
  const view = render(
    <TooltipProvider delayDuration={0}>
      {ui}
      <Toaster />
    </TooltipProvider>,
  )
  return { user, ...view }
}

describe('TimestampInfo', () => {
  it('shows the time in the zone asked for, as a time element with the exact instant', () => {
    renderInfo(<TimestampInfo timestamp={INSTANT} timezone="Europe/Berlin" />)

    const time = screen.getByText('13 Oct 2026 16:03:22')
    expect(time.tagName).toBe('TIME')
    expect(time).toHaveAttribute('datetime', '2026-10-13T14:03:22.000Z')
  })

  it('shows UTC when asked to', () => {
    renderInfo(<TimestampInfo timestamp={INSTANT} timezone="Asia/Tokyo" displayAs="utc" />)

    expect(screen.getByText('13 Oct 2026 14:03:22')).toBeInTheDocument()
  })

  it('takes the zone of the provider when it has no own', () => {
    renderInfo(
      <TimestampInfoProvider timezone="Asia/Tokyo">
        <TimestampInfo timestamp={INSTANT} />
      </TimestampInfoProvider>,
    )

    expect(screen.getByText('13 Oct 2026 23:03:22')).toBeInTheDocument()
  })

  it('lets the own zone win over the provider and shortens the label by precision', () => {
    renderInfo(
      <TimestampInfoProvider timezone="Asia/Tokyo">
        <TimestampInfo timestamp={INSTANT} timezone="UTC" precision="minute" />
      </TimestampInfoProvider>,
    )

    expect(screen.getByText('13 Oct 2026 14:03')).toBeInTheDocument()
  })

  it('shows a label given instead of the formatted time', () => {
    renderInfo(<TimestampInfo timestamp={INSTANT} label="4 minutes ago" />)

    const time = screen.getByText('4 minutes ago')
    expect(time).toHaveAttribute('datetime', '2026-10-13T14:03:22.000Z')
  })

  it('shows a value that is no instant as received, marked invalid, without a tooltip', () => {
    renderInfo(<TimestampInfo timestamp="soon" />)

    expect(screen.getByText('soon (invalid time)')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('reads a string without a zone designator as UTC', () => {
    renderInfo(<TimestampInfo timestamp="2026-10-13 14:03:22" timezone="UTC" />)

    expect(screen.getByText('13 Oct 2026 14:03:22')).toHaveAttribute(
      'datetime',
      '2026-10-13T14:03:22.000Z',
    )
  })

  it('opens the detail on keyboard focus: UTC, the zone, the age and the exact instant', async () => {
    const { user } = renderInfo(
      <TimestampInfo timestamp={INSTANT} timezone="Europe/Berlin" now={NOW} />,
    )

    await user.tab()
    const button = screen.getByRole('button')
    expect(button).toHaveFocus()
    const tooltip = await screen.findByRole('tooltip')

    expect(tooltip).toHaveTextContent('UTC13 Oct 2026 14:03:22')
    expect(tooltip).toHaveTextContent('Europe/Berlin13 Oct 2026 16:03:22')
    expect(tooltip).toHaveTextContent('Relative4 minutes ago')
    expect(tooltip).toHaveTextContent('Instant2026-10-13T14:03:22.000Z')
    expect(button).toHaveAccessibleDescription(/UTC/)

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
  })

  it('lists the zone of the viewer next to a zone picked for reading', async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      locale: 'en-US',
      calendar: 'gregory',
      numberingSystem: 'latn',
      timeZone: 'America/New_York',
    })
    const { user } = renderInfo(
      <TimestampInfo timestamp={INSTANT} timezone="Europe/Berlin" now={NOW} />,
    )

    await user.tab()
    const tooltip = await screen.findByRole('tooltip')

    expect(tooltip).toHaveTextContent('Europe/Berlin13 Oct 2026 16:03:22')
    expect(tooltip).toHaveTextContent('America/New_York13 Oct 2026 10:03:22')
  })

  it('copies the UTC instant and says so in a toast', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const { user } = renderInfo(
      <TimestampInfo timestamp={INSTANT} timezone="Europe/Berlin" now={NOW} />,
    )

    await user.click(screen.getByRole('button'))

    expect(await screen.findByText(/Timestamp copied/)).toBeInTheDocument()
    expect(await navigator.clipboard.readText()).toBe('2026-10-13T14:03:22.000Z')
  })

  it('says when the clipboard refused, and does not claim success', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const { user } = renderInfo(<TimestampInfo timestamp={INSTANT} now={NOW} />)
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))

    await user.click(screen.getByRole('button'))

    const region = await screen.findByRole('region', { name: /Notifications/ })
    expect(await within(region).findByText(/Could not copy the timestamp/)).toBeInTheDocument()
    expect(screen.queryByText(/Timestamp copied/)).not.toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    const { container } = renderInfo(<TimestampInfo timestamp={INSTANT} now={NOW} />)

    expect(await axeViolations(container)).toEqual([])
  })
})
