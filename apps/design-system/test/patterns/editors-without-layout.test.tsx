import '@testing-library/jest-dom/vitest'
import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderDemo } from './support.tsx'

afterEach(cleanup)

/**
 * The environment of the component tests has no layout engine, and CodeMirror measures text with
 * one. The editor demos say so instead of mounting an editor that can only log errors; the tests
 * of `ui-data.test.tsx` install a stand-in for the layout and render the real editors.
 */
describe('the editor demos in an environment without a layout engine', () => {
  it.each([
    ['ui-data/sql-editor/query', 'The SQL editor needs a browser'],
    ['ui-data/sql-editor/draft', 'The SQL editor needs a browser'],
    ['ui-data/sql-editor/readonly', 'The SQL editor needs a browser'],
    ['ui-data/text-diff/migration', 'The text diff needs a browser'],
    ['ui-data/readable-text-diff/ready', 'The text diff needs a browser'],
  ])('says so for %s and mounts no editor', async (id, title) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { container } = renderDemo(id)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.getByText(title)).toBeInTheDocument()
    expect(container.querySelector('[data-exdb-editor]')).toBeNull()
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('still shows the states of a read that need no editor', () => {
    renderDemo('ui-data/readable-text-diff/failed')
    expect(screen.getByText('Could not read migration text')).toBeInTheDocument()
  })
})
