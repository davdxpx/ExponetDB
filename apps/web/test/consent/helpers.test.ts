import { afterEach, describe, expect, it, vi } from 'vitest'
import { inlineName } from '../../src/features/consent/inline-name.ts'
import { browserNavigation, isLeavableUrl, leaveTo } from '../../src/features/consent/leave.ts'

describe('a client name as plain text', () => {
  it('shows hidden, direction and control characters by code point', () => {
    expect(inlineName('Ada ‮evil')).toBe('Ada ⟨U+202E⟩evil')
    expect(inlineName('a​b⁦c\nd\te')).toBe('a⟨U+200B⟩b⟨U+2066⟩c⟨U+000A⟩d⟨U+0009⟩e')
    expect(inlineName('tag\u{E0041}')).toBe('tag⟨U+E0041⟩')
  })

  it('keeps markup as text and cuts long names by code points', () => {
    expect(inlineName('<img src=x onerror=1>')).toBe('<img src=x onerror=1>')
    expect(inlineName('😀'.repeat(50), 48)).toBe(`${'😀'.repeat(48)}…`)
    expect(inlineName('x'.repeat(48))).toBe('x'.repeat(48))
  })

  it('has no text for an empty name', () => {
    expect(inlineName('')).toBeUndefined()
  })
})

describe('leaving for the client', () => {
  afterEach(() => vi.restoreAllMocks())

  it('opens only absolute http(s) addresses', () => {
    expect(isLeavableUrl('https://agent.example.test/callback?code=x')).toBe(true)
    expect(isLeavableUrl('http://127.0.0.1:53682/callback?code=x')).toBe(true)
    for (const url of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:x',
      '//evil.example.test/',
      '/account',
      'file:///etc/passwd',
      '',
    ]) {
      expect(isLeavableUrl(url), url).toBe(false)
    }
  })

  it('assigns the address as the server sent it, or nothing', () => {
    const assign = vi.spyOn(browserNavigation, 'assign').mockImplementation(() => undefined)
    expect(leaveTo('https://agent.example.test/callback?code=x&state=y')).toBe(true)
    expect(assign).toHaveBeenCalledWith('https://agent.example.test/callback?code=x&state=y')
    expect(leaveTo('javascript:alert(1)')).toBe(false)
    expect(assign).toHaveBeenCalledTimes(1)
  })
})
