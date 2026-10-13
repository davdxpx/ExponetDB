// Derived from supabase/supabase packages/ui-patterns/src/CommandMenu/internal/state/pagesState.test.ts @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { beforeEach, describe, expect, it } from 'vitest'

import {
  type CommandPageDefinition,
  CommandPageType,
  type IPagesState,
  initPagesState,
} from '../../../../src/command-menu/internal/state/pages-state.ts'

const emptyPage = (): CommandPageDefinition => ({ type: CommandPageType.Commands, sections: [] })

describe('pagesState', () => {
  let pagesState: IPagesState

  beforeEach(() => {
    pagesState = initPagesState()
  })

  it('Starts with an empty page stack', () => {
    expect(pagesState.getState().pageStack.length).toBe(0)
  })

  it('Starts with no pages', () => {
    expect(Object.keys(pagesState.getState().commandPages).length).toBe(0)
  })

  it('Registers a new page', () => {
    const newPage = emptyPage()

    pagesState.registerNewPage('page', newPage)

    expect(pagesState.getState().commandPages['page']).toStrictEqual(newPage)
  })

  it('Returned function unregisters the page', () => {
    const newPage = emptyPage()

    const unregister = pagesState.registerNewPage('page', newPage)
    expect(pagesState.getState().commandPages['page']).toStrictEqual(newPage)

    unregister()
    expect(Object.keys(pagesState.getState().commandPages).length).toBe(0)
  })

  it('Registered page can be appended to page stack', () => {
    pagesState.registerNewPage('page', emptyPage())
    pagesState.appendPageStack('page')

    expect(pagesState.getState().pageStack.length).toBe(1)
    expect(pagesState.getState().pageStack[0]).toBe('page')
  })

  it('Non-registered page cannot be appended to page stack', () => {
    pagesState.appendPageStack('invalid')

    expect(pagesState.getState().pageStack.length).toBe(0)
  })

  it('Unregistered page cannot be appended to page stack', () => {
    const unregister = pagesState.registerNewPage('page', emptyPage())
    unregister()

    pagesState.appendPageStack('page')

    expect(pagesState.getState().pageStack.length).toBe(0)
  })

  it('Noops if reappending the currently active page', () => {
    pagesState.registerNewPage('page', emptyPage())

    pagesState.appendPageStack('page')
    pagesState.appendPageStack('page')

    expect(pagesState.getState().pageStack.length).toBe(1)
    expect(pagesState.getState().pageStack[0]).toBe('page')
  })

  it('Unregistered page is automatically popped from stack', () => {
    const unregister = pagesState.registerNewPage('page', emptyPage())
    pagesState.appendPageStack('page')
    expect(pagesState.getState().pageStack.length).toBe(1)

    unregister()
    expect(pagesState.getState().pageStack.length).toBe(0)
  })

  it('Does not error when popping from empty pagestack', () => {
    expect(() => pagesState.popPageStack()).not.toThrowError()
  })

  it('Pops the page on top of the stack only', () => {
    pagesState.registerNewPage('one', emptyPage())
    pagesState.registerNewPage('two', emptyPage())
    pagesState.appendPageStack('one')
    pagesState.appendPageStack('two')

    pagesState.popPageStack()
    expect(pagesState.getState().pageStack).toEqual(['one'])
  })

  it('Leaves every page at once when the stack is reset', () => {
    pagesState.registerNewPage('one', emptyPage())
    pagesState.registerNewPage('two', emptyPage())
    pagesState.appendPageStack('one')
    pagesState.appendPageStack('two')

    pagesState.resetPageStack()
    expect(pagesState.getState().pageStack).toEqual([])
    expect(Object.keys(pagesState.getState().commandPages)).toEqual(['one', 'two'])
  })
})
