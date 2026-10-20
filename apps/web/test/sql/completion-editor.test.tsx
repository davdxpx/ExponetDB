import '@testing-library/jest-dom/vitest'
import type { SchemaObject, SchemaObjectRef } from '@exponetdb/sdk/operations'
import type { EditorHandle } from '@exponetdb/ui-data'
import { SqlEditor } from '@exponetdb/ui-data/editor/sql-editor'
import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { installLayoutStubs } from '../../../../packages/ui-data/test/editor/support.ts'
import { createCompletionProvider } from '../../src/features/sql/completion.ts'
import type { ApiClient } from '../../src/lib/api/client.ts'

/**
 * The real editor (CodeMirror in a shadow root) with the real completion
 * provider of the page and a fake API: what a person gets after typing `u.`
 * in a statement with `FROM users u` after the cursor.
 */
beforeAll(installLayoutStubs)
afterEach(cleanup)

const USERS: SchemaObjectRef = {
  kind: 'table',
  schema: 'public',
  name: 'users',
  signature: null,
  parent: null,
  key: ['public', 'users'],
}

function usersObject(): SchemaObject {
  const column = (name: string, type: string) => ({
    name,
    type,
    nullable: true,
    default: null,
    generated: null,
    identity: null,
  })
  return {
    columns: [column('id', 'bigint'), column('email', 'text'), column('Created At', 'timestamptz')],
    comment: null,
    constraints: null,
    definition: null,
    grants: null,
    indexes: null,
    observedAt: '2026-10-20T10:00:00Z',
    owner: 'app',
    policies: null,
    ref: USERS,
    rowLevelSecurity: null,
    sizeBytes: null,
    source: 'live',
  }
}

function provider(operation: ReturnType<typeof vi.fn>) {
  return createCompletionProvider(
    { operation } as unknown as ApiClient,
    new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    'shop/platform/staging',
  )
}

async function suggestions(
  text: string,
  cursorColumn: number,
  operation: ReturnType<typeof vi.fn>,
) {
  const ref = createRef<EditorHandle>()
  const view = render(
    <SqlEditor
      ref={ref}
      value={text}
      mode="draft"
      label="SQL draft of a change"
      completion={provider(operation)}
    />,
  )
  const root = view.container.querySelector('[data-exdb-editor]')?.shadowRoot
  if (root === null || root === undefined) throw new Error('no shadow root')
  act(() => {
    ref.current?.focus()
    ref.current?.setSelection(1, cursorColumn)
  })
  const content = root.querySelector('.cm-content')
  if (content === null) throw new Error('no content')
  await act(async () => {
    fireEvent.keyDown(content, { key: ' ', code: 'Space', ctrlKey: true })
  })
  await waitFor(() =>
    expect(root.querySelector('.cm-tooltip-autocomplete [role="option"]')).not.toBeNull(),
  )
  return Array.from(root.querySelectorAll('.cm-tooltip-autocomplete [role="option"]')).map(
    (option) => option.textContent ?? '',
  )
}

describe('column completion in the editor', () => {
  it('offers the columns of the aliased relation, with the types, from a FROM clause after the cursor', async () => {
    const operation = vi.fn(async (id: string) =>
      id === 'searchSchema' ? { items: [USERS], nextCursor: null } : usersObject(),
    )
    const options = await suggestions(
      'select u. from public.users u',
      'select u.'.length + 1,
      operation,
    )
    expect(options.some((o) => o.startsWith('id') && o.includes('bigint'))).toBe(true)
    expect(options.some((o) => o.startsWith('email') && o.includes('text'))).toBe(true)
    // A name that needs quotes is offered quoted.
    expect(options.some((o) => o.includes('"Created At"'))).toBe(true)
    const kinds = operation.mock.calls.map((call) => call[0])
    expect(kinds).toEqual(['searchSchema', 'getSchemaObject'])
  })
})
