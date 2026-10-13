import { afterEach, describe, expect, it } from 'vitest'

import {
  COMMAND_MENU_ATTRIBUTE,
  hasOpenDialog,
  isTextEntryTarget,
} from '../../src/shortcuts/dom.ts'

afterEach(() => {
  document.body.innerHTML = ''
})

function append(tag: string, attributes: Record<string, string> = {}): HTMLElement {
  const element = document.createElement(tag)
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value)
  document.body.append(element)
  return element
}

describe('isTextEntryTarget', () => {
  it('is true for fields people type into and pick from', () => {
    expect(isTextEntryTarget(append('input'))).toBe(true)
    expect(isTextEntryTarget(append('textarea'))).toBe(true)
    expect(isTextEntryTarget(append('select'))).toBe(true)
  })

  it('is true for content-editable elements and their children', () => {
    const editor = append('div', { contenteditable: 'true' })
    const inner = document.createElement('span')
    editor.append(inner)
    expect(isTextEntryTarget(editor)).toBe(true)
    expect(isTextEntryTarget(inner)).toBe(true)
    expect(isTextEntryTarget(append('div', { contenteditable: 'false' }))).toBe(false)
  })

  it('is true for widgets that use letters themselves', () => {
    for (const role of [
      'textbox',
      'searchbox',
      'combobox',
      'spinbutton',
      'listbox',
      'menu',
      'menubar',
    ]) {
      expect(isTextEntryTarget(append('div', { role })), role).toBe(true)
    }
  })

  it('is true for an item inside such a widget', () => {
    const menu = append('div', { role: 'menu' })
    const item = document.createElement('button')
    item.setAttribute('role', 'menuitem')
    menu.append(item)
    expect(isTextEntryTarget(item)).toBe(true)
  })

  it('is false for the page itself, a button and a link', () => {
    expect(isTextEntryTarget(document.body)).toBe(false)
    expect(isTextEntryTarget(append('button'))).toBe(false)
    expect(isTextEntryTarget(append('a', { href: '/audit' }))).toBe(false)
    expect(isTextEntryTarget(null)).toBe(false)
    expect(isTextEntryTarget(document)).toBe(false)
  })
})

describe('hasOpenDialog', () => {
  it('sees a dialog Radix marks as open, an alert dialog and a native dialog', () => {
    append('div', { role: 'dialog', 'data-state': 'open' })
    expect(hasOpenDialog(document)).toBe(true)
    document.body.innerHTML = ''

    append('div', { role: 'alertdialog', 'data-state': 'open' })
    expect(hasOpenDialog(document)).toBe(true)
    document.body.innerHTML = ''

    append('dialog', { open: '' })
    expect(hasOpenDialog(document)).toBe(true)
  })

  it('does not see a closed dialog', () => {
    append('div', { role: 'dialog', 'data-state': 'closed' })
    append('dialog')
    expect(hasOpenDialog(document)).toBe(false)
  })

  it('can leave out the command menu', () => {
    append('div', { role: 'dialog', 'data-state': 'open', [COMMAND_MENU_ATTRIBUTE]: '' })
    expect(hasOpenDialog(document)).toBe(true)
    expect(hasOpenDialog(document, `[${COMMAND_MENU_ATTRIBUTE}]`)).toBe(false)

    append('div', { role: 'dialog', 'data-state': 'open' })
    expect(hasOpenDialog(document, `[${COMMAND_MENU_ATTRIBUTE}]`)).toBe(true)
  })
})
