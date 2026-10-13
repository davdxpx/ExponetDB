import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  InitialTile,
  InterstitialLayout,
  initialOf,
  LogoPair,
  ProductTile,
} from '../../src/layouts/interstitial-layout.tsx'
import { SignInLayout } from '../../src/layouts/sign-in-layout.tsx'

afterEach(cleanup)

describe('the sign-in layout', () => {
  it('renders the text mark, one h1 and the form in the main landmark, without remote content', async () => {
    const { container } = render(
      <SignInLayout heading="Sign in" subheading="Use a passkey." footer="Lost your passkey?">
        <form aria-label="Sign in">
          <button type="submit">Sign in with a passkey</button>
        </form>
      </SignInLayout>,
    )
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument()
    expect(screen.getByRole('main')).toContainElement(screen.getByRole('form', { name: 'Sign in' }))
    expect(screen.getByText('ExponetDB')).toBeInTheDocument()
    expect(screen.getByText('Lost your passkey?')).toBeInTheDocument()
    expect(container.querySelectorAll('img, a[href^="http"], blockquote')).toHaveLength(0)
    expect(await axeViolations()).toEqual([])
  })
})

describe('the interstitial layout', () => {
  it('renders the logo row, the title and the description in a card in the main landmark', async () => {
    render(
      <InterstitialLayout
        logo={<LogoPair left={<InitialTile name="Cursor" />} right={<ProductTile />} />}
        title="Authorize Cursor"
        description="This application wants to access ExponetDB"
        footer="Authorizing will redirect you to cursor.example"
      >
        <div className="px-6 pb-6">
          <button type="button">Authorize Cursor</button>
        </div>
      </InterstitialLayout>,
    )
    const main = screen.getByRole('main')
    expect(main).toContainElement(
      screen.getByRole('heading', { level: 1, name: 'Authorize Cursor' }),
    )
    expect(screen.getByText('This application wants to access ExponetDB')).toBeInTheDocument()
    expect(screen.getByText('C')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByText('E')).toHaveAttribute('aria-hidden', 'true')
    expect(document.querySelectorAll('img')).toHaveLength(0)
    expect(await axeViolations()).toEqual([])
  })
})

describe('the initial of a name', () => {
  it('is the first letter or digit, upper-cased, and never markup, a control or a bidi character', () => {
    expect(initialOf('cursor')).toBe('C')
    expect(initialOf('  9lives')).toBe('9')
    expect(initialOf('\u{202E}evil')).toBe('E')
    expect(initialOf('<script>')).toBe('S')
    expect(initialOf('\u{E0041}\u{200B}')).toBe('?')
    expect(initialOf('')).toBe('?')
    expect(initialOf('ärzte')).toBe('Ä')
  })
})
