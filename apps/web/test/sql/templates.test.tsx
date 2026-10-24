import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  DRAFT_TEMPLATES,
  QUERY_TEMPLATES,
  type SqlTemplate,
  TEMPLATES,
} from '../../src/features/sql/templates.ts'
import { t } from '../../src/lib/i18n/i18n.ts'
import { bodyOf, clearStorage, editor, SQL, world } from './helpers.tsx'
import { mountSql } from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))
vi.mock('@exponetdb/ui-data/editor/sql-editor', async () =>
  (await import('./stand-ins.tsx')).editorModule(),
)
vi.mock('@exponetdb/ui-data/grid/data-grid', async () =>
  (await import('./stand-ins.tsx')).gridModule(),
)

beforeEach(clearStorage)
afterEach(cleanup)

/** The text of a template without comments, for the checks of its shape. */
function code(template: SqlTemplate): string {
  return template.sql.replace(/--[^\n]*/g, '')
}

describe('the template list', () => {
  it('has unique ids, a title and a description for each, and the two groups', () => {
    expect(new Set(TEMPLATES.map((template) => template.id)).size).toBe(TEMPLATES.length)
    for (const template of TEMPLATES) {
      expect(t(template.titleKey).length, template.id).toBeGreaterThan(3)
      expect(t(template.descriptionKey).length, template.id).toBeGreaterThan(10)
      expect(t(template.titleKey), template.id).not.toMatch(/[{}]/)
      expect(t(template.descriptionKey), template.id).not.toMatch(/[{}]/)
    }
    expect(QUERY_TEMPLATES.every((template) => template.mode === 'query')).toBe(true)
    expect(DRAFT_TEMPLATES.every((template) => template.mode === 'draft')).toBe(true)
    expect(QUERY_TEMPLATES.map((template) => template.id)).toEqual([
      'version',
      'sessions',
      'sizes',
      'index-usage',
      'extensions',
      'long-transactions',
    ])
  })

  it.each(QUERY_TEMPLATES.map((template) => [template.id, template] as const))(
    'query template %s is one read of the catalog and changes nothing',
    (_id, template) => {
      const text = code(template).trim()
      expect(text).toMatch(/^select\b/i)
      // One statement: the only semicolon is the last character.
      expect(text.indexOf(';')).toBe(text.length - 1)
      // Only the system catalogs and statistics views, schema-qualified so no search path decides.
      const relations = [...text.matchAll(/\b(?:from|join)\s+([A-Za-z_][\w.]*)/gi)].map(
        (match) => match[1] ?? '',
      )
      for (const relation of relations) expect(relation).toMatch(/^pg_catalog\.pg_\w+$/)
      expect(text).not.toMatch(
        /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|copy|call|do|set|reset|lock|vacuum|analyze|listen|notify|pg_terminate_backend|pg_cancel_backend|pg_sleep|lo_\w+|dblink\w*|pg_read_\w+|set_config|nextval|setval)\b/i,
      )
      // The text of other sessions' statements is not selected.
      expect(text).not.toMatch(/\bquery\b\s*[,\s]/i)
    },
  )

  it.each(DRAFT_TEMPLATES.map((template) => [template.id, template] as const))(
    'draft template %s is one statement that changes the schema',
    (_id, template) => {
      const text = code(template).trim()
      expect(text).toMatch(/^(create|alter)\b/i)
      expect(text.indexOf(';')).toBe(text.length - 1)
    },
  )

  it('adds an index concurrently, a check constraint not valid, and validates it in a step of its own', () => {
    const byId = (id: string) => TEMPLATES.find((template) => template.id === id)?.sql ?? ''
    expect(byId('add-index')).toMatch(/^CREATE INDEX CONCURRENTLY /)
    expect(byId('add-check')).toMatch(/CHECK \(.+\) NOT VALID;$/s)
    expect(byId('validate-check')).toMatch(/VALIDATE CONSTRAINT example_name_not_blank;$/)
  })
})

describe('opening a template', () => {
  async function openTemplates(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('tab', { name: 'Templates' }))
    return document.querySelector('[data-block="sql-templates"]') as HTMLElement
  }

  it('lists the query templates and the draft templates in the side panel', async () => {
    const user = userEvent.setup()
    mountSql(SQL, world())
    await editor()
    const panel = await openTemplates(user)
    expect(within(panel).getByRole('heading', { name: 'Queries' })).toBeInTheDocument()
    expect(within(panel).getByRole('heading', { name: 'Changes to draft' })).toBeInTheDocument()
    expect(panel.querySelectorAll('[data-template-mode="query"]')).toHaveLength(6)
    expect(panel.querySelectorAll('[data-template-mode="draft"]')).toHaveLength(5)
    expect(within(panel).getByText('PostgreSQL version')).toBeInTheDocument()
    expect(within(panel).getByText('Add an index concurrently')).toBeInTheDocument()
    expect(await axeViolations()).toEqual([])
  })

  it('puts a query template in a new Query tab with a note that it was not run', async () => {
    const user = userEvent.setup()
    const w = world()
    mountSql(SQL, w)
    await editor()
    const panel = await openTemplates(user)
    const version = panel.querySelector('[data-template="version"]') as HTMLElement
    await user.click(within(version).getByRole('button', { name: 'Open in a new tab' }))
    const area = await editor()
    expect(area).toHaveValue('SELECT pg_catalog.version() AS version;')
    expect(area).toHaveAttribute('data-mode', 'query')
    expect(screen.getByText('From a template, not run')).toBeInTheDocument()
    expect(document.querySelector('[data-origin-note="template"]')?.textContent).toMatch(
      /Nothing was run/,
    )
    expect(document.querySelectorAll('nav[aria-label="Query tabs"] li')).toHaveLength(2)
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(w.calls('POST', '/queries')).toEqual([])
    expect(w.calls('POST', '/explain')).toEqual([])
    expect(await axeViolations()).toEqual([])
  })

  it('runs a query template only when the person presses Run', async () => {
    const user = userEvent.setup()
    const w = world()
    mountSql(SQL, w)
    await editor()
    const panel = await openTemplates(user)
    const sessions = panel.querySelector('[data-template="sessions"]') as HTMLElement
    await user.click(within(sessions).getByRole('button', { name: 'Open in a new tab' }))
    await editor()
    expect(w.calls('POST', '/queries')).toEqual([])
    await user.click(screen.getByRole('button', { name: /^Run/ }))
    await screen.findByTestId('grid')
    expect(w.calls('POST', '/queries')).toHaveLength(1)
    expect(bodyOf<{ sql: string }>(w.calls('POST', '/queries')[0])?.sql).toContain(
      'pg_catalog.pg_stat_activity',
    )
  })

  it('puts a draft template in a new Draft tab that offers no Run', async () => {
    const user = userEvent.setup()
    const w = world()
    mountSql(SQL, w)
    await editor()
    const panel = await openTemplates(user)
    const create = panel.querySelector('[data-template="create-table"]') as HTMLElement
    await user.click(within(create).getByRole('button', { name: 'Open in a new tab' }))
    const area = await editor()
    expect(area).toHaveAttribute('data-mode', 'draft')
    expect(area.value).toMatch(/^CREATE TABLE public\.example \(/)
    expect(screen.getByText('From a template, not run')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Run/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Create migration' })).toBeEnabled()
    await waitFor(() =>
      expect(w.calls('POST', '/sql/classifications').length).toBeGreaterThanOrEqual(1),
    )
    expect(w.calls('POST', '/queries')).toEqual([])
  })

  it('opens each template in its own tab and keeps the tabs', async () => {
    const user = userEvent.setup()
    mountSql(SQL, world())
    await editor()
    const panel = await openTemplates(user)
    for (const id of ['extensions', 'add-column']) {
      const row = panel.querySelector(`[data-template="${id}"]`) as HTMLElement
      await user.click(within(row).getByRole('button', { name: 'Open in a new tab' }))
    }
    expect(document.querySelectorAll('nav[aria-label="Query tabs"] li')).toHaveLength(3)
    expect(
      document.querySelectorAll('nav[aria-label="Query tabs"] li[data-origin="template"]'),
    ).toHaveLength(2)
    expect(await editor()).toHaveValue('ALTER TABLE public.example ADD COLUMN note text;')
  })

  it('keeps the template origin when the tabs are read back, so the note is still there', async () => {
    const user = userEvent.setup()
    const w = world()
    mountSql(SQL, w)
    await editor()
    const panel = await openTemplates(user)
    const row = panel.querySelector('[data-template="extensions"]') as HTMLElement
    await user.click(within(row).getByRole('button', { name: 'Open in a new tab' }))
    await editor()
    cleanup()
    mountSql(SQL, world())
    expect(await screen.findByText('From a template, not run')).toBeInTheDocument()
    expect(await editor()).toHaveValue(
      QUERY_TEMPLATES.find((template) => template.id === 'extensions')?.sql ?? '',
    )
  })

  it('opens from the keyboard', async () => {
    const user = userEvent.setup()
    mountSql(SQL, world())
    await editor()
    const tab = await screen.findByRole('tab', { name: 'Templates' })
    tab.focus()
    await user.keyboard('{Enter}')
    const panel = document.querySelector('[data-block="sql-templates"]') as HTMLElement
    const first = within(panel).getAllByRole('button', { name: 'Open in a new tab' })[0]
    expect(first).toBeDefined()
    first?.focus()
    await user.keyboard('{Enter}')
    expect(await editor()).toHaveValue('SELECT pg_catalog.version() AS version;')
  })
})
