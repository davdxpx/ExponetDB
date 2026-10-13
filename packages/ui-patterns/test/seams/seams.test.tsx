import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type LinkComponentProps,
  LinkProvider,
  NavigateProvider,
  resolveColorScheme,
  TelemetryProvider,
  useColorScheme,
  useLinkComponent,
  useNavigate,
  useTelemetry,
} from '../../src/seams/index.ts'

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('data-theme')
})

function Probe(): React.ReactNode {
  const Link = useLinkComponent()
  return <Link href="/changes/plans">Plans</Link>
}

describe('link seam', () => {
  it('renders a plain anchor without a provider', () => {
    render(<Probe />)
    const link = screen.getByRole('link', { name: 'Plans' })
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe('/changes/plans')
  })

  it('renders the provided component', () => {
    function RouterLink({ href, children }: LinkComponentProps): React.ReactNode {
      return (
        <a href={href} data-router="yes">
          {children}
        </a>
      )
    }
    render(
      <LinkProvider component={RouterLink}>
        <Probe />
      </LinkProvider>,
    )
    expect(screen.getByRole('link', { name: 'Plans' }).getAttribute('data-router')).toBe('yes')
  })
})

describe('navigate seam', () => {
  it('does nothing without a provider and calls the provided navigate', () => {
    const calls: string[] = []
    function Go(): React.ReactNode {
      const navigate = useNavigate()
      return (
        <button type="button" onClick={() => navigate('/audit')}>
          Open audit
        </button>
      )
    }
    const { unmount } = render(<Go />)
    act(() => screen.getByRole('button').click())
    expect(window.location.pathname).toBe('/')
    unmount()
    render(
      <NavigateProvider navigate={(path) => calls.push(path)}>
        <Go />
      </NavigateProvider>,
    )
    act(() => screen.getByRole('button').click())
    expect(calls).toEqual(['/audit'])
  })
})

describe('telemetry seam', () => {
  it('is a no-op by default and forwards events to the provider', () => {
    const seen = vi.fn()
    function Emit(): React.ReactNode {
      const emit = useTelemetry()
      return (
        <button type="button" onClick={() => emit({ name: 'command_menu_opened' })}>
          Emit
        </button>
      )
    }
    const { unmount } = render(<Emit />)
    expect(() => act(() => screen.getByRole('button').click())).not.toThrow()
    unmount()
    render(
      <TelemetryProvider onTelemetry={seen}>
        <Emit />
      </TelemetryProvider>,
    )
    act(() => screen.getByRole('button').click())
    expect(seen).toHaveBeenCalledWith({ name: 'command_menu_opened' })
  })
})

describe('color scheme seam', () => {
  it('resolves the attribute before the system preference', () => {
    expect(resolveColorScheme(null, false)).toBe('light')
    expect(resolveColorScheme(null, true)).toBe('dark')
    expect(resolveColorScheme('dark', false)).toBe('dark')
    expect(resolveColorScheme('classic-dark', false)).toBe('dark')
    expect(resolveColorScheme('light', true)).toBe('light')
    expect(resolveColorScheme('unknown', true)).toBe('dark')
  })

  it('follows changes of data-theme on <html>', async () => {
    function Scheme(): React.ReactNode {
      return <output>{useColorScheme()}</output>
    }
    render(<Scheme />)
    expect(screen.getByRole('status').textContent).toBe('light')
    await act(async () => {
      document.documentElement.setAttribute('data-theme', 'dark')
      await Promise.resolve()
    })
    expect(screen.getByRole('status').textContent).toBe('dark')
  })
})

describe('isAppPath', () => {
  it('accepts app paths and refuses anything a browser could read as another origin', async () => {
    const { isAppPath } = await import('../../src/seams/index.ts')
    expect(isAppPath('/changes/plans')).toBe(true)
    expect(isAppPath('/t/exponet/platform/production?tab=1#x')).toBe(true)
    for (const hostile of [
      '//evil.example',
      '/\\evil.example',
      '/\t/evil.example',
      '/\n/evil.example',
      'https://evil.example',
      'javascript:alert(1)',
      ' /changes',
      'changes',
      '',
    ]) {
      expect(isAppPath(hostile), hostile).toBe(false)
    }
  })
})
