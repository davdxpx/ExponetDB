// @vitest-environment node
// The Wave 3A app's own tests (a hand-made document in node); removed with the app in Phase 8.
import type { ApprovalQueueItem } from '@exponetdb/contracts'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { markedLine, reviewSection } from '../src/review.ts'

/**
 * The plan review's marking of characters a reader cannot see (Wave 7 order
 * §24): every invisible or direction character shows its code point, in the
 * raw text and in the names inside the facts ExponetDB computed. The unit
 * tests have no browser: a minimal tree stands in for `document`, enough for
 * the element builder (`dom.ts`); the browser run is the end-to-end suite.
 */
class Fake {
  readonly children: Fake[] = []
  readonly attrs = new Map<string, string>()
  readonly tag: string
  readonly data: string
  constructor(tag: string, data = '') {
    this.tag = tag
    this.data = data
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value)
  }
  addEventListener(): void {}
  appendChild(child: Fake): Fake {
    this.children.push(child)
    return child
  }
  get textContent(): string {
    return this.tag === '#text' ? this.data : this.children.map((c) => c.textContent).join('')
  }
}

beforeAll(() => {
  vi.stubGlobal('document', {
    createElement: (tag: string) => new Fake(tag),
    createTextNode: (text: string) => new Fake('#text', text),
  })
})
afterAll(() => {
  vi.unstubAllGlobals()
})

const cp = (...points: number[]) => String.fromCodePoint(...points)
const label = (point: number) => `⟨U+${point.toString(16).toUpperCase().padStart(4, '0')}⟩`

/** The nodes of a marked line as the text a reader sees. */
function shown(line: string): string {
  return markedLine(line)
    .nodes.map((n) => (typeof n === 'string' ? n : (n as unknown as Fake).textContent))
    .join('')
}

function find(node: Fake, test: (n: Fake) => boolean): Fake[] {
  return [...(test(node) ? [node] : []), ...node.children.flatMap((c) => find(c, test))]
}

describe('markedLine', () => {
  it('names the code point of a soft hyphen and of every other invisible filler', () => {
    const fillers = [
      0x00ad, // soft hyphen
      0x034f, // combining grapheme joiner
      0x115f,
      0x1160, // Hangul choseong and jungseong fillers
      0x17b4,
      0x17b5, // Khmer inherent vowels
      0x180b,
      0x180e, // Mongolian free variation selector and vowel separator
      0x2028,
      0x2029, // line and paragraph separators
      0x2060,
      0x2061,
      0x2062,
      0x2063,
      0x2064, // word joiner and invisible operators
      0x2066,
      0x2069, // isolates
      0x206f,
      0x3164, // Hangul filler
      0xfe0f, // variation selector
      0xfeff,
      0xffa0, // halfwidth Hangul filler
      0xfff9,
      0xe0041, // tag letter
      0xe0100, // variation selector supplement
    ]
    for (const point of fillers) {
      const { nodes, marked } = markedLine(`a${cp(point)}b`)
      expect(marked, label(point)).toBe(1)
      const span = nodes.find((n) => typeof n !== 'string') as unknown as Fake
      expect(span.attrs.get('class'), label(point)).toBe('mark hidden-char')
      expect(shown(`a${cp(point)}b`), label(point)).toBe(`a${label(point)}b`)
    }
  })

  it('keeps marking controls and direction characters, shows other non-ASCII, leaves ASCII alone', () => {
    expect(shown(`a${cp(0x200b)}${cp(0x202e)}${cp(0x07)}`)).toBe(
      `a${label(0x200b)}${label(0x202e)}${label(0x07)}`,
    )
    expect(shown('DROP TABLE public.accounts;')).toBe('DROP TABLE public.accounts;')
    const visible = markedLine('Grüße ✅')
    expect(visible.marked).toBe(3)
    expect(visible.nodes.filter((n) => typeof n !== 'string')).toHaveLength(3)
    for (const n of visible.nodes) {
      if (typeof n !== 'string') {
        expect((n as unknown as Fake).attrs.get('class')).toBe('mark non-ascii')
      }
    }
    expect(shown('a\tb')).toBe('a→   b')
  })
  it('marks every default-ignorable and format character by code point, by Unicode property', () => {
    // Musical symbol formatting and shorthand format controls draw nothing in a browser:
    // a name holding them would look exactly like the name without them.
    for (const point of [0x1d173, 0x1d17a, 0x1bca0, 0x0600, 0x06dd, 0x070f, 0x110bd, 0x13430]) {
      expect(shown(`users${cp(point)}`), point.toString(16)).toBe(`users${label(point)}`)
    }
  })
})

describe('the facts ExponetDB computed', () => {
  const MIGRATION = '01M4S9000000000000000000AB'
  const SHY = cp(0x00ad)
  const review = {
    clientName: `Agent${SHY}Official`,
    sources: [],
    plan: {
      kind: 'migration.apply',
      class: 'high',
      decision: 'require',
      requirements: [],
      policyRules: [],
      planHash: `sha256:ph1:${'ab'.repeat(32)}`,
      expiresAt: '2026-10-13T09:00:00.000Z',
      actor: { identityId: 'idn_01M4S9000000000000000000AD', kind: 'human', via: 'mcp' },
      subject: { targetPath: 'shop/platform/production', tier: 'prod' },
      change: {
        content: {
          migrations: [
            {
              migrationId: MIGRATION,
              name: `add${SHY}notes`,
              checksum: `sha256:c1:${'ef'.repeat(32)}`,
            },
          ],
          facts: { evidence: 'present' },
          expectedState: { schemaFingerprint: `sha256:fp1:${'01'.repeat(32)}` },
        },
        analysis: {
          perMigration: [
            {
              migrationId: MIGRATION,
              statements: [],
              compatibility: { declared: 'additive', observed: 'destructive', agreement: false },
              destructive: [`table public.acc${SHY}ounts`, `table public.${cp(0x3164)}secrets`],
              lockSeverity: 'blocking',
              rewriteRisk: [{ relation: `public.big${cp(0x115f)}`, rows: 10, bytes: 100 }],
              rollback: { available: false, declaredSafety: null },
            },
          ],
          summary: { compatibility: 'destructive', lockSeverity: 'blocking', destructive: true },
        },
      },
    },
  } as unknown as NonNullable<ApprovalQueueItem['review']>

  let root: Fake
  beforeAll(() => {
    root = reviewSection(review) as unknown as Fake
  })

  it('marks the dropped objects and the table rewrites by code point, as the raw text is', () => {
    const drops = find(root, (n) => n.tag === 'li' && n.attrs.get('class') === 'destructive')
    expect(drops.map((n) => n.textContent)).toEqual([
      `table public.acc${label(0x00ad)}ounts`,
      `table public.${label(0x3164)}secrets`,
    ])
    const rewrites = find(root, (n) => n.tag === 'li' && n.textContent.includes('10 rows'))
    expect(rewrites.map((n) => n.textContent)).toEqual([
      `public.big${label(0x115f)}: 10 rows, 100 bytes`,
    ])
  })

  it('marks the migration name and the client name too', () => {
    const [heading] = find(root, (n) => n.tag === 'h4')
    expect(heading?.textContent).toBe(`add${label(0x00ad)}notes (${MIGRATION})`)
    const [client] = find(root, (n) => n.tag === 'q')
    expect(client?.textContent).toBe(`Agent${label(0x00ad)}Official`)
  })

  it('lays foreign names out left to right in logical order', () => {
    const foreign = find(root, (n) => n.attrs.get('class') === 'foreign')
    expect(foreign.length).toBeGreaterThan(0)
    for (const span of foreign) expect(span.attrs.get('dir')).toBe('ltr')
  })

  it('leaves an unmarked name as plain text', () => {
    const plain = {
      ...review,
      clientName: 'Plain Agent',
    } as unknown as NonNullable<ApprovalQueueItem['review']>
    const [client] = find(reviewSection(plain) as unknown as Fake, (n) => n.tag === 'q')
    expect(client?.textContent).toBe('Plain Agent')
    // One left-to-right wrapper around text nodes only: nothing in the name is marked.
    expect(client?.children.map((c) => c.attrs.get('class'))).toEqual(['foreign'])
    expect(client?.children[0]?.children.every((c) => c.tag === '#text')).toBe(true)
  })
})

describe('the files the plan runs', () => {
  const MIGRATION = '01M4S9000000000000000000AB'
  const UP = 'ALTER TABLE public.accounts ADD COLUMN notes text;'
  const VERIFY = 'SELECT count(*) = 1 AS ok FROM information_schema.columns;'
  const source = (file: string, text: string) => ({
    migrationId: MIGRATION,
    revision: 1,
    file,
    text,
    bytes: text.length,
    truncated: false,
  })
  const review = (sources: unknown[]) =>
    ({
      clientName: null,
      sources,
      plan: {
        kind: 'migration.apply',
        class: 'high',
        decision: 'require',
        requirements: [],
        policyRules: [],
        planHash: `sha256:ph1:${'ab'.repeat(32)}`,
        expiresAt: '2026-10-13T09:00:00.000Z',
        actor: { identityId: 'idn_01M4S9000000000000000000AD', kind: 'human', via: 'mcp' },
        subject: { targetPath: 'shop/platform/production', tier: 'prod' },
        change: {
          content: {
            migrations: [{ migrationId: MIGRATION, name: 'add-notes', checksum: 'sha256:c1:x' }],
            facts: {},
            expectedState: {},
          },
          analysis: {
            perMigration: [
              {
                migrationId: MIGRATION,
                statements: [
                  { line: 1, index: 0, kind: 'ALTER TABLE', lock: { mode: 'ACCESS EXCLUSIVE' } },
                ],
              },
            ],
            summary: {},
          },
        },
      },
    }) as unknown as NonNullable<ApprovalQueueItem['review']>
  const banners = (root: Fake) =>
    find(root, (n) => n.tag === 'p' && (n.attrs.get('class') ?? '').includes('banner warn')).map(
      (n) => n.textContent,
    )

  it('shows verify.sql next to up.sql, with the statement facts on up.sql only', () => {
    const root = reviewSection(
      review([source('up.sql', UP), source('verify.sql', VERIFY)]),
    ) as unknown as Fake
    const sections = find(root, (n) => n.tag === 'section' && n.attrs.get('class') === 'source')
    expect(sections.map((s) => find(s, (n) => n.tag === 'h4')[0]?.textContent)).toEqual([
      `up.sql of ${MIGRATION} (revision 1), ${String(UP.length)} bytes`,
      `verify.sql of ${MIGRATION} (revision 1), ${String(VERIFY.length)} bytes`,
    ])
    const starts = (s: Fake | undefined) =>
      s === undefined ? -1 : find(s, (n) => n.attrs.get('class') === 'statement-start').length
    expect(starts(sections[0])).toBe(1)
    expect(starts(sections[1])).toBe(0)
    expect(banners(root).filter((b) => b.startsWith('This page shows'))).toEqual([])
  })

  it('says how many files it does not show', () => {
    const root = reviewSection(review([source('up.sql', UP)])) as unknown as Fake
    expect(banners(root)).toContain(
      'This page shows 1 of the 2 files the plan runs (at most 64). Review the others before you decide: exponetdb migration show <migration>.',
    )
  })
})
