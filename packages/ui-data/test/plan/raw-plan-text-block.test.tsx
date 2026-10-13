import '@testing-library/jest-dom/vitest'
import { splitLines } from '@exponetdb/ui-patterns'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  type RawPlanFile,
  RawPlanTextBlock,
  type RawStatementStart,
} from '../../src/plan/raw-plan-text-block.tsx'
import { axeViolations } from '../support/axe.ts'
import { RLO, renderPlan, TAG_A, ZWSP } from './support.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const MIGRATION = '01JABCDEFGHJKMNPQRSTVWXYZ0'

function file(text: string, statements: Record<number, RawStatementStart> = {}): RawPlanFile {
  return {
    migrationId: MIGRATION,
    file: 'up.sql',
    revision: 1,
    bytes: text.length,
    truncated: false,
    lines: splitLines(text).map((line, i) => ({ text: line, statement: statements[i + 1] })),
    text,
  }
}

function rows(): HTMLTableRowElement[] {
  return [...document.querySelectorAll<HTMLTableRowElement>('tbody tr')]
}

describe('RawPlanTextBlock', () => {
  it('shows each line numbered and verbatim, under "What the plan runs"', async () => {
    const text = 'CREATE TABLE a (id int);\nSELECT 1;'
    renderPlan(<RawPlanTextBlock files={[file(text)]} omitted={0} runs={1} />)
    expect(screen.getByRole('heading', { name: 'What the plan runs' })).toBeInTheDocument()
    expect(screen.getByText(/not checked by ExponetDB/)).toBeInTheDocument()
    const lines = rows()
    expect(lines).toHaveLength(2)
    expect(lines[0]?.cells[0]).toHaveTextContent('1')
    expect(lines[0]?.cells[1]?.textContent).toBe('CREATE TABLE a (id int);')
    expect(lines[1]?.cells[0]).toHaveTextContent('2')
    expect(await axeViolations()).toEqual([])
  })

  it('shows direction, zero-width and tag characters by code point, and marks non-ASCII', async () => {
    const text = `-- harmless${RLO}PORD\nDROP${ZWSP} TABLE users;\nSELECT 'x${TAG_A}';\nSELECT 'p\u{0430}ss';`
    renderPlan(<RawPlanTextBlock files={[file(text)]} omitted={0} runs={1} />)
    const table = document.querySelector('table.source-text') as HTMLElement
    expect(table).toHaveTextContent('⟨U+202E⟩')
    expect(table).toHaveTextContent('⟨U+200B⟩')
    expect(table).toHaveTextContent('⟨U+E0041⟩')
    expect(table.textContent).not.toContain(RLO)
    expect(table.textContent).not.toContain(ZWSP)
    expect(table.textContent).not.toContain(TAG_A)
    // The Cyrillic letter is shown, but marked as non-ASCII.
    expect(table.querySelector('[data-segment="non-ascii"]')).toHaveAttribute(
      'data-code-point',
      'U+0430',
    )
    expect(
      screen.getByText(
        /3 hidden characters shown as code points; 1 non-ASCII character underlined/,
      ),
    ).toBeInTheDocument()
    expect(await axeViolations()).toEqual([])
  })

  it('renders markup and links in the text as text, never as elements', () => {
    const text = `<script>alert(1)</script>\n<a href="javascript:alert(1)">approve</a>\n<img src=x onerror=alert(1)>\nhttps://example.invalid/approve?plan=1`
    const { container } = renderPlan(<RawPlanTextBlock files={[file(text)]} omitted={0} runs={1} />)
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    expect(rows()[0]?.cells[1]?.textContent).toBe('<script>alert(1)</script>')
    expect(rows()[3]?.cells[1]?.textContent).toBe('https://example.invalid/approve?plan=1')
  })

  it('puts the server facts on the line where a statement starts', () => {
    const text = 'CREATE TABLE a (id int);\nDROP TABLE b;'
    renderPlan(
      <RawPlanTextBlock
        files={[
          file(text, {
            1: { index: 0, kind: 'CREATE TABLE', lock: null, compatibility: 'additive' },
            2: {
              index: 1,
              kind: 'DROP TABLE',
              lock: 'ACCESS EXCLUSIVE',
              compatibility: 'destructive',
              destructive: true,
            },
          }),
        ]}
        omitted={0}
        runs={1}
      />,
    )
    const [first, second] = rows()
    expect(first).toHaveClass('statement-start')
    expect(first).toHaveTextContent('Statement 1: CREATE TABLE, no lock, additive')
    expect(second).toHaveTextContent('Statement 2: DROP TABLE, lock ACCESS EXCLUSIVE, destructive')
    expect(second?.querySelector('[data-statement-start] svg')).not.toBeNull()
  })

  it('says "lock not known" where the facts do not say whether a lock is taken', () => {
    renderPlan(
      <RawPlanTextBlock
        files={[file('ALTER TABLE a ADD b int;', { 1: { index: 0, kind: 'ALTER TABLE' } })]}
        omitted={0}
        runs={1}
      />,
    )
    expect(rows()[0]).toHaveTextContent('lock not known, compatibility not known')
  })

  it('collapses a long file with an explicit count, names hidden statements and expands on request', async () => {
    const user = userEvent.setup()
    const text = Array.from({ length: 250 }, (_, i) =>
      i === 239 ? 'DROP TABLE users;' : `-- filler ${i + 1}`,
    ).join('\n')
    renderPlan(
      <RawPlanTextBlock
        files={[
          file(text, {
            240: {
              index: 0,
              kind: 'DROP TABLE',
              lock: 'ACCESS EXCLUSIVE',
              compatibility: 'destructive',
              destructive: true,
            },
          }),
        ]}
        omitted={0}
        runs={1}
      />,
    )
    expect(rows()).toHaveLength(200)
    expect(screen.getByText('50 more lines not shown (lines 201 to 250).')).toBeInTheDocument()
    expect(
      screen.getByText(
        '1 statement starts in them, at line 240, including a destructive statement.',
      ),
    ).toBeInTheDocument()
    expect(await axeViolations()).toEqual([])
    await user.click(screen.getByRole('button', { name: /^Show 50 more lines/ }))
    expect(rows()).toHaveLength(250)
    expect(rows()[239]).toHaveTextContent('DROP TABLE users;')
    expect(screen.queryByText(/more lines not shown/)).toBeNull()
    await user.click(screen.getByRole('button', { name: /^Show only the first 200 lines/ }))
    expect(rows()).toHaveLength(200)
  })

  it('offers "Show all" for a file far longer than one step', async () => {
    const user = userEvent.setup()
    const text = Array.from({ length: 1_000 }, (_, i) => `SELECT ${i};`).join('\n')
    renderPlan(<RawPlanTextBlock files={[file(text)]} omitted={0} runs={1} collapsedLines={10} />)
    expect(rows()).toHaveLength(10)
    await user.click(screen.getByRole('button', { name: /^Show 500 more lines/ }))
    expect(rows()).toHaveLength(510)
    expect(screen.getByText('490 more lines not shown (lines 511 to 1,000).')).toBeInTheDocument()
    // Fewer lines remain than one step adds: the step itself shows them all.
    expect(screen.queryByRole('button', { name: /^Show all/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: /^Show only the first 10 lines/ }))
    expect(rows()).toHaveLength(10)
    await user.click(screen.getByRole('button', { name: /^Show all 1,000 lines/ }))
    expect(rows()).toHaveLength(1_000)
    expect(screen.queryByText(/more lines? not shown/)).toBeNull()
  })

  it('says when the server sent only the beginning of a file', () => {
    renderPlan(
      <RawPlanTextBlock
        files={[{ ...file('SELECT 1;'), truncated: true, bytes: 400_000 }]}
        omitted={0}
        runs={1}
      />,
    )
    expect(
      screen.getByText(
        `ExponetDB shows the beginning of this file only (the file has 400,000 bytes). Review the whole file before you decide: exponetdb migration show ${MIGRATION}`,
      ),
    ).toBeInTheDocument()
  })

  it('names the files the plan runs that this page does not show', () => {
    renderPlan(<RawPlanTextBlock files={[file('SELECT 1;')]} omitted={65} runs={66} />)
    expect(screen.getByText(/This page shows 1 of the 66 files the plan runs/)).toBeInTheDocument()
  })

  it('says "not known" when it is not known whether every file is shown, or which files', () => {
    renderPlan(<RawPlanTextBlock files={null} omitted={null} runs={null} />)
    expect(screen.getByText(/Whether this page shows every file/)).toHaveTextContent('not known')
    expect(screen.getByText(/The files of this plan are/)).toHaveTextContent('not known')
  })

  it('copies each file exactly as received', async () => {
    const user = userEvent.setup()
    const text = `SELECT 1;\r\nSELECT 2;${RLO}\r\n`
    renderPlan(<RawPlanTextBlock files={[file(text)]} omitted={0} runs={1} />)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await user.click(screen.getByRole('button', { name: `Copy up.sql of ${MIGRATION}` }))
    await waitFor(() => expect(screen.getByText('up.sql copied.')).toBeInTheDocument())
    expect(await navigator.clipboard.readText()).toBe(text)
  })

  it('never puts statement facts on verify.sql lines', () => {
    const verify = {
      ...file('SELECT count(*) = 1 FROM a;', {
        1: { index: 0, kind: 'DROP TABLE', lock: 'ACCESS EXCLUSIVE', destructive: true },
      }),
      file: 'verify.sql',
    }
    renderPlan(<RawPlanTextBlock files={[verify]} omitted={0} runs={1} />)
    expect(document.querySelector('[data-statement-start]')).toBeNull()
    expect(rows()[0]).not.toHaveClass('statement-start')
  })

  it('keeps each file in its own section, in the order given', () => {
    const verify = { ...file('SELECT true;'), file: 'verify.sql' }
    renderPlan(<RawPlanTextBlock files={[file('SELECT 1;'), verify]} omitted={0} runs={2} />)
    const sections = [...document.querySelectorAll('section[data-file]')]
    expect(sections.map((s) => s.getAttribute('data-file'))).toEqual(['up.sql', 'verify.sql'])
    expect(within(sections[1] as HTMLElement).getByText('SELECT true;')).toBeInTheDocument()
  })
})

/**
 * The review model of the Web App (`apps/web/src/features/plans/review-model.ts`,
 * `SourceView`) is passed to this block as it is. The shape is restated here
 * (the UI package does not import the app) so a change on either side fails
 * the type check.
 */
interface ReviewModelSourceView {
  readonly migrationId: string
  readonly file: string
  readonly revision: number
  readonly bytes: number
  readonly truncated: boolean
  readonly shownCharacters: number
  readonly lines: readonly {
    readonly number: number
    readonly text: string
    readonly statement:
      | {
          readonly index: number
          readonly kind: string
          readonly line: number | undefined
          readonly lock: string | undefined
          readonly compatibility: string | undefined
          readonly destructive: boolean
        }
      | undefined
  }[]
  readonly marked: number
}

describe('RawPlanFile and the review model', () => {
  it('accepts the review model output as it is', () => {
    const source: ReviewModelSourceView = {
      migrationId: MIGRATION,
      file: 'up.sql',
      revision: 1,
      bytes: 9,
      truncated: false,
      shownCharacters: 9,
      lines: [{ number: 1, text: 'SELECT 1;', statement: undefined }],
      marked: 0,
    }
    const files: readonly RawPlanFile[] = [source]
    renderPlan(<RawPlanTextBlock files={files} omitted={0} runs={1} />)
    expect(rows()[0]?.cells[1]?.textContent).toBe('SELECT 1;')
  })
})
