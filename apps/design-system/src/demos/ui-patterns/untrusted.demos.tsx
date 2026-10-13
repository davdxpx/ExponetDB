import { MarkedCode, UntrustedName, UntrustedText } from '@exponetdb/ui-patterns'
import type { DemoDefinition } from '../types.ts'

/**
 * Hostile values for the demos, written with braced escapes so that no invisible
 * or direction character is in this file:
 * - U+202E right-to-left override, U+200B zero-width space, U+2066 left-to-right isolate;
 * - U+05D0 a Hebrew letter, which a naive renderer would let move the digits after it;
 * - U+0430 a Cyrillic letter that looks like the Latin a.
 */
const HOSTILE_SQL = [
  '-- reviewed by ops \u{05D0} + 99',
  'select id, total\u{200B} from orders',
  "where status = 'open'\u{202E};",
  "\tand created_at > now() - interval '1 day'; -- \u{2066}drop table orders",
].join('\n')

const LONG_SQL = Array.from(
  { length: 24 },
  (_, index) =>
    `insert into orders (id, status) values (${index + 1}, '${index % 2 === 0 ? 'open' : 'closed'}');`,
).join('\n')

const LONG_NAME = `orders_${'archived_'.repeat(14)}2026`

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui-patterns/untrusted-text/hostile-sql',
    title: 'Untrusted text: SQL with hidden characters, a tab and a right-to-left letter',
    render: () => <UntrustedText text={HOSTILE_SQL} mono label="SQL text" />,
  },
  {
    id: 'ui-patterns/untrusted-text/long-value',
    title: 'Untrusted text: a long value is cut by lines and opens with an explicit control',
    render: () => <UntrustedText text={LONG_SQL} mono maxLines={6} label="SQL text" />,
  },
  {
    id: 'ui-patterns/untrusted-text/markup',
    title: 'Untrusted text: markup is text',
    render: () => (
      <UntrustedText
        text={'<a href="/targets">click</a> **bold** [link](javascript:void(0)) <b>x</b>'}
        label="comment"
      />
    ),
  },
  {
    id: 'ui-patterns/untrusted-name/names',
    title: 'Untrusted name: one line, with the marker "name not verified" for a client',
    render: () => (
      <ul className="flex flex-col gap-2 text-sm">
        <li>
          <UntrustedName name="orders" label="table name" />
        </li>
        <li>
          <UntrustedName name="Deploy bot" unverified label="client name" />
        </li>
        <li>
          <UntrustedName name={'ord\u{200B}ers\u{202E}'} label="table name" />
        </li>
        <li>
          <UntrustedName name={'line one\nline two'} label="object name" />
        </li>
        <li>
          <UntrustedName name={LONG_NAME} maxCodePoints={40} mono label="table name" />
        </li>
        <li>
          <UntrustedName name="" label="comment" />
        </li>
      </ul>
    ),
  },
  {
    id: 'ui-patterns/marked-code/target-path',
    title: 'Marked code: a target path whose second segment has a look-alike letter',
    render: () => (
      <div className="flex flex-col gap-2 text-sm">
        <p>
          Real: <MarkedCode text="shop/platform/production" />
        </p>
        <p>
          Look-alike: <MarkedCode text={'shop/pl\u{0430}tform/production'} />
        </p>
        <p>
          With a hidden character: <MarkedCode text={'shop/platform/production\u{200B}'} />
        </p>
      </div>
    ),
  },
]
