import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from '../src/app.tsx'

describe('design-system app', () => {
  it('renders its heading', () => {
    render(<App />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('ExponetDB design system')
  })
})
