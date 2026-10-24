import { fireEvent, screen } from '@testing-library/react'
import { project, type Sent, SqlWorld } from './support.tsx'

/**
 * Small helpers the focused SQL page tests share: the fake server with the
 * staging and production targets, the editor stand-in's text area and a clean
 * browser storage. A test file still declares the three `vi.mock` calls
 * itself (the shell, the editor and the grid; see `stand-ins.tsx`).
 */
export const STAGING = 'shop/platform/staging'
export const SQL = '/t/shop/platform/staging/sql'
export const PROD_SQL = '/t/shop/platform/production/sql'

export function world(): SqlWorld {
  const w = new SqlWorld()
  project(w)
  w.sample(STAGING)
  w.sample('shop/platform/production')
  return w
}

export async function editor(): Promise<HTMLTextAreaElement> {
  return (await screen.findByRole('textbox', { name: /SQL (query|draft)/ })) as HTMLTextAreaElement
}

export function type(area: HTMLTextAreaElement, text: string): void {
  fireEvent.change(area, { target: { value: text } })
}

/** Selects a range of the text area, as a person does with the mouse or the keyboard. */
export function select(area: HTMLTextAreaElement, from: number, to: number): void {
  area.setSelectionRange(from, to)
  fireEvent.select(area)
}

export function clearStorage(): void {
  try {
    window.localStorage.clear()
  } catch {
    // no storage in this run
  }
}

/** The JSON body of a recorded request, or `undefined` when there was no such request. */
export function bodyOf<T>(sent: Sent | undefined): T | undefined {
  return sent?.body as T | undefined
}
