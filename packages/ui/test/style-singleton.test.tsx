import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { stylesheetSingleton } from '../src/csp/style-singleton.ts'

/** jsdom has no constructable stylesheets: a small stand-in with the same surface. */
class FakeSheet {
  css = ''
  replaceSync(css: string): void {
    this.css = css
  }
}

type Doc = { adoptedStyleSheets?: FakeSheet[] }
const doc = document as unknown as Doc
const globals = globalThis as unknown as { CSSStyleSheet?: unknown }

let originalSheet: unknown

beforeEach(() => {
  originalSheet = globals.CSSStyleSheet
  globals.CSSStyleSheet = FakeSheet
  doc.adoptedStyleSheets = []
})

afterEach(() => {
  globals.CSSStyleSheet = originalSheet
  delete doc.adoptedStyleSheets
})

describe('the CSP style singleton (react-style-singleton alias)', () => {
  it('adds one adopted stylesheet for the first user and removes it with the last', () => {
    const sheet = stylesheetSingleton()

    sheet.add('body { overflow: hidden }')
    sheet.add('body { overflow: hidden }')
    expect(doc.adoptedStyleSheets).toHaveLength(1)
    expect(doc.adoptedStyleSheets?.[0]?.css).toBe('body { overflow: hidden }')

    sheet.remove()
    expect(doc.adoptedStyleSheets).toHaveLength(1)
    sheet.remove()
    expect(doc.adoptedStyleSheets).toHaveLength(0)
  })

  it('never creates a <style> element', () => {
    const before = document.querySelectorAll('style').length
    const sheet = stylesheetSingleton()

    sheet.add('a { color: red }')

    expect(document.querySelectorAll('style')).toHaveLength(before)
    sheet.remove()
  })

  it('tolerates an extra remove', () => {
    const sheet = stylesheetSingleton()
    sheet.remove()
    sheet.add('a { color: red }')
    expect(doc.adoptedStyleSheets).toHaveLength(1)
    sheet.remove()
    expect(doc.adoptedStyleSheets).toHaveLength(0)
  })

  it('does nothing where constructable stylesheets are unavailable', () => {
    delete doc.adoptedStyleSheets
    const sheet = stylesheetSingleton()

    expect(() => {
      sheet.add('a { color: red }')
      sheet.remove()
    }).not.toThrow()
    expect(document.querySelectorAll('style')).toHaveLength(0)
  })
})
