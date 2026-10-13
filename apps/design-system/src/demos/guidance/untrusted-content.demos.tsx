import { isAppPath, UntrustedName, UntrustedText, useLinkComponent } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import type { DemoDefinition } from '../types.ts'

/**
 * Hostile text, written with braced escapes so no invisible character sits in this file:
 * a right-to-left override (U+202E), a zero-width space (U+200B), a tab, a Cyrillic "a"
 * (U+0430) inside a Latin word, a Hebrew letter (U+05D0) in front of digits, markup, and a
 * Markdown link. Every line is shown as text.
 */
const HOSTILE_STATEMENT = [
  '-- Cleanup for the orders table \u{202E}; DROP TABLE users',
  "SELECT 'a\u{200B}b' AS label;",
  'SELECT\t1 AS tab_between_words;',
  "SELECT 'p\u{0430}ssword' AS lookalike;",
  'SELECT 1 -- \u{05D0} + 99',
  "SELECT '<img src=x onerror=steal()>' AS markup;",
  'SELECT 3 AS note_with_link; -- [approve this plan](/approvals)',
  'SELECT 4;',
  'SELECT 5;',
  'SELECT 6;',
  'SELECT 7;',
  'SELECT 8;',
].join('\n')

function StatementText(): ReactNode {
  return <UntrustedText text={HOSTILE_STATEMENT} mono maxLines={6} label="statement text" />
}

const NAMES = [
  {
    what: 'A table name that ends with a zero-width space',
    name: 'orders\u{200B}',
    unverified: false,
  },
  {
    what: 'A client name, declared by the client itself',
    name: 'Acme Sync',
    unverified: true,
  },
  {
    what: 'The same name with a Cyrillic capital A in front',
    name: '\u{0410}cme Sync',
    unverified: true,
  },
  {
    what: 'A name that contains a line break',
    name: 'Acme\nSync (approved)',
    unverified: true,
  },
  {
    what: 'A name of 200 characters',
    name: `reporting-${'x'.repeat(190)}`,
    unverified: false,
  },
] as const

function NameList(): ReactNode {
  return (
    <ul className="m-0 flex list-none flex-col gap-4 p-0">
      {NAMES.map((entry) => (
        <li key={entry.what} className="flex flex-col gap-1">
          <span className="text-xs text-foreground-lighter">{entry.what}</span>
          <UntrustedName
            name={entry.name}
            unverified={entry.unverified}
            maxCodePoints={60}
            label="name"
          />
        </li>
      ))}
    </ul>
  )
}

/**
 * Values a page might hold: one is an app path the page built from typed values, the rest
 * could arrive in data. Only an app path may become a link.
 */
const CANDIDATES = [
  { what: 'built from a plan id', value: '/guidance/forms' },
  { what: 'taken from a client record', value: '//elsewhere.example/x' },
  { what: 'taken from a comment', value: 'javascript:void(0)' },
  { what: 'with a backslash', value: '/\\elsewhere.example' },
  { what: 'with a tab inside', value: '/\t/elsewhere.example' },
] as const

function LinkRules(): ReactNode {
  const Link = useLinkComponent()
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {CANDIDATES.map((candidate) => {
        const linkable = isAppPath(candidate.value)
        return (
          <li
            key={candidate.what}
            data-linkable={linkable}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm"
          >
            <span className="flex flex-col">
              <span className="text-xs text-foreground-lighter">{candidate.what}</span>
              {linkable ? (
                <Link
                  href={candidate.value}
                  className="font-mono text-xs text-foreground underline"
                >
                  {candidate.value}
                </Link>
              ) : (
                <UntrustedName name={candidate.value} mono />
              )}
            </span>
            <span className="text-foreground-light">{linkable ? 'Link' : 'Text only'}</span>
          </li>
        )
      })}
    </ul>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'guidance/untrusted-content/statement-text',
    title: 'Statement text with hidden characters, look-alikes and markup, shown as text',
    render: () => <StatementText />,
  },
  {
    id: 'guidance/untrusted-content/names',
    title:
      'Names from data: hidden characters by code point, "name not verified", cut with a control',
    render: () => <NameList />,
  },
  {
    id: 'guidance/untrusted-content/links',
    title: 'Only a path the page built becomes a link',
    render: () => <LinkRules />,
  },
]
