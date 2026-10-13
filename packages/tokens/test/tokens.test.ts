import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/tokens.css', import.meta.url), 'utf8')

describe('token inputs', () => {
  it('declares every theme input of design-system.md §2', () => {
    for (const input of [
      '--hue',
      '--surface-hue',
      '--chroma',
      '--surface',
      '--foreground-lightness',
      '--contrast',
      '--elevation-step',
    ]) {
      expect(css).toContain(`${input}:`)
    }
  })

  it('uses the placeholder hue, not the Supabase brand hue', () => {
    expect(css).toMatch(/--hue:\s*255;/)
    expect(css).not.toMatch(/157\.5|--brand-/)
  })
})
