import { afterEach, describe, expect, it } from 'vitest'
import {
  applySavedChange,
  checkSavedName,
  copyName,
  newTab,
  SAVED_NAME_MAX,
  TAB_ORIGINS,
  type TabsState,
} from '../../src/features/sql/sql-model.ts'
import { loadTabs, saveTabs } from '../../src/features/sql/tab-storage.ts'

afterEach(() => {
  try {
    window.localStorage.clear()
  } catch {
    // no storage
  }
})

const SAVED = {
  id: 'sqy_01M4V3RV9F5XM2TB8KC6QZJ0NS',
  name: 'Open orders',
  revision: 3,
  visibility: 'personal' as const,
  owned: true,
}

describe('the name of a saved query', () => {
  it('accepts a name of 1 to 120 code points after trimming', () => {
    expect(checkSavedName('Orders')).toBe('ok')
    expect(checkSavedName('  Orders  ')).toBe('ok')
    expect(checkSavedName('x'.repeat(SAVED_NAME_MAX))).toBe('ok')
    expect(checkSavedName('😀'.repeat(SAVED_NAME_MAX))).toBe('ok')
  })

  it('refuses an empty name and a name over the bound, by code points', () => {
    expect(checkSavedName('')).toBe('empty')
    expect(checkSavedName('   ')).toBe('empty')
    expect(checkSavedName('x'.repeat(SAVED_NAME_MAX + 1))).toBe('too_long')
    expect(checkSavedName('😀'.repeat(SAVED_NAME_MAX + 1))).toBe('too_long')
  })
})

describe('copyName', () => {
  const suffix = (name: string) => `${name} (copy)`

  it('adds the suffix', () => {
    expect(copyName('Orders', suffix)).toBe('Orders (copy)')
  })

  it('cuts the name, not the suffix, so the copy still fits', () => {
    const copy = copyName('x'.repeat(SAVED_NAME_MAX), suffix)
    expect([...copy]).toHaveLength(SAVED_NAME_MAX)
    expect(copy.endsWith(' (copy)')).toBe(true)
    expect(checkSavedName(copy)).toBe('ok')
  })

  it('never cuts a character in two', () => {
    const copy = copyName('😀'.repeat(SAVED_NAME_MAX), suffix)
    expect([...copy]).toHaveLength(SAVED_NAME_MAX)
    expect(copy).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
  })
})

describe('applySavedChange', () => {
  function state(revision: number): TabsState {
    const tab = newTab('query', 'SELECT 1', 'saved', { ...SAVED, revision })
    const other = newTab('query', 'SELECT 2')
    return { tabs: [tab, other], active: tab.id }
  }

  const after = { id: SAVED.id, name: 'Renamed', visibility: 'project' as const, revision: 4 }

  it('gives a tab that was current the new name, visibility and revision', () => {
    const next = applySavedChange(state(3), { id: SAVED.id, revision: 3 }, after)
    expect(next.tabs[0]?.saved).toMatchObject({
      name: 'Renamed',
      visibility: 'project',
      revision: 4,
    })
    expect(next.tabs[0]?.sql).toBe('SELECT 1')
  })

  it('keeps the revision of a tab that was based on an older one, so its save meets the conflict', () => {
    const next = applySavedChange(state(2), { id: SAVED.id, revision: 3 }, after)
    expect(next.tabs[0]?.saved).toMatchObject({
      name: 'Renamed',
      visibility: 'project',
      revision: 2,
    })
  })

  it('leaves other tabs and other saved queries alone', () => {
    const before = state(3)
    const next = applySavedChange(
      before,
      { id: 'sqy_01M4V3RV9F5XM2TB8KC6QZJ0N2', revision: 3 },
      after,
    )
    expect(next).toEqual(before)
    expect(applySavedChange(before, { id: SAVED.id, revision: 3 }, after).tabs[1]).toBe(
      before.tabs[1],
    )
  })
})

describe('the template origin', () => {
  it('is one of the origins a tab may have', () => {
    expect(TAB_ORIGINS).toContain('template')
  })

  it('is kept in storage and read back, and an unknown origin is still dropped', () => {
    const tab = newTab('draft', 'CREATE TABLE public.example ()', 'template')
    saveTabs('idn_1', 'tgt_1', { tabs: [tab], active: tab.id })
    const loaded = loadTabs('idn_1', 'tgt_1')
    expect(loaded?.tabs[0]).toMatchObject({ mode: 'draft', origin: 'template' })

    window.localStorage.setItem(
      'exdb.sql.tabs.idn_1.tgt_2',
      JSON.stringify({ tabs: [{ mode: 'query', sql: 'x', origin: 'templates' }], active: 0 }),
    )
    expect(loadTabs('idn_1', 'tgt_2')).toBeUndefined()
  })
})
