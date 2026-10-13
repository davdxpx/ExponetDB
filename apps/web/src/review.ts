import type { ApprovalQueueItem } from '@exponetdb/contracts'
import { type Child, formatTime, h } from './dom.ts'

/**
 * The plan review of the approvals page (Wave 7 order §24): what a person
 * decides on. Two parts, never mixed: what ExponetDB computed from the
 * stored plan (target, tier, kind, class, compatibility, locks, destructive
 * objects, rollback, evidence, the policy decision with its rules, expiry,
 * the full plan hash, who created it through which client), and what the
 * plan contains as raw text (the statements exactly as stored, with line
 * numbers). Everything from outside ExponetDB (SQL, object names, comments,
 * the client's name) is text only: `textContent`, never markup, never a
 * link; control, bidi, invisible and non-ASCII characters are made visible.
 */
type Review = NonNullable<ApprovalQueueItem['review']>
type Json = Record<string, unknown>

const obj = (v: unknown): Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {}
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

/** Every default-ignorable, format or control character and the line and paragraph separators. */
const IGNORABLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}\p{Zl}\p{Zp}]/u

/**
 * Characters that change what a reader sees without being seen themselves:
 * control, bidi and format characters, line and paragraph separators, and the
 * invisible fillers (soft hyphen, Hangul and Khmer fillers, Mongolian
 * separators, variation selectors), by Unicode property and by the explicit
 * list below.
 */
function invisible(cp: number): boolean {
  return (
    IGNORABLE.test(String.fromCodePoint(cp)) ||
    cp < 0x20 ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0x00ad ||
    cp === 0x034f ||
    cp === 0x061c ||
    (cp >= 0x115f && cp <= 0x1160) ||
    (cp >= 0x17b4 && cp <= 0x17b5) ||
    (cp >= 0x180b && cp <= 0x180f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x2028 && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    cp === 0x3164 ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0xfeff ||
    cp === 0xffa0 ||
    (cp >= 0xfff0 && cp <= 0xfffb) ||
    (cp >= 0xe0000 && cp <= 0xe0fff)
  )
}

/**
 * One line of raw text as nodes: printable ASCII as text; a tab as a
 * visible arrow; every invisible, control or bidi character as a marker
 * naming its code point (it never acts); other non-ASCII characters shown
 * but marked. Returns how many characters were marked.
 */
export function markedLine(line: string): { readonly nodes: Child[]; readonly marked: number } {
  const nodes: Child[] = []
  let plain = ''
  let marked = 0
  const flush = () => {
    if (plain.length > 0) nodes.push(plain)
    plain = ''
  }
  for (const ch of line) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp === 0x09) {
      flush()
      nodes.push(h('span', { class: 'mark tab' }, '→   '))
    } else if (invisible(cp)) {
      flush()
      marked++
      nodes.push(
        h(
          'span',
          { class: 'mark hidden-char' },
          `⟨U+${cp.toString(16).toUpperCase().padStart(4, '0')}⟩`,
        ),
      )
    } else if (cp > 0x7e) {
      flush()
      marked++
      nodes.push(h('span', { class: 'mark non-ascii' }, ch))
    } else {
      plain += ch
    }
  }
  flush()
  return { nodes, marked }
}

/**
 * A name from outside ExponetDB inside a fact: marked like the raw text, never
 * plain, and laid out left to right in logical order (`.foreign` in app.css).
 */
function foreign(text: string): Child[] {
  return [h('span', { class: 'foreign', dir: 'ltr' }, ...markedLine(text).nodes)]
}

/** The statements of one file, verbatim, numbered; statement starts carry the server's facts. */
function sourceBlock(source: Review['sources'][number], analysis: Json | undefined): HTMLElement {
  const starts = new Map<number, Json>()
  for (const s of arr(analysis?.['statements'])) {
    const line = num(obj(s)['line'])
    if (line !== undefined) starts.set(line, obj(s))
  }
  const lines = source.text.split(/\r\n|\n|\r/)
  let marked = 0
  const rows = lines.map((text, i) => {
    const line = i + 1
    const rendered = markedLine(text)
    marked += rendered.marked
    const facts = starts.get(line)
    const lock = obj(facts?.['lock'])
    return h(
      'tr',
      facts === undefined ? {} : { class: 'statement-start' },
      h('td', { class: 'line' }, String(line)),
      h(
        'td',
        { class: 'text', dir: 'ltr' },
        facts === undefined
          ? null
          : h(
              'span',
              { class: 'badge stmt' },
              [
                `#${String((num(facts['index']) ?? 0) + 1)} ${str(facts['kind']) ?? ''}`,
                str(lock['mode']) === undefined ? 'no lock' : `lock ${str(lock['mode'])}`,
                str(facts['compatibility']) ?? '',
              ]
                .filter((x) => x.length > 0)
                .join(' · '),
            ),
        ...rendered.nodes,
      ),
    )
  })
  return h(
    'section',
    { class: 'source', 'data-migration': source.migrationId },
    h(
      'h4',
      {},
      `${source.file} of ${source.migrationId} (revision ${String(source.revision)}), ${String(source.bytes)} bytes`,
    ),
    marked === 0
      ? null
      : h(
          'p',
          { class: 'banner warn', role: 'note' },
          `${String(marked)} character(s) are not plain ASCII and are marked below; invisible and direction characters are shown by their code point.`,
        ),
    h('table', { class: 'source-text' }, h('tbody', {}, ...rows)),
    source.truncated
      ? h(
          'p',
          { class: 'banner warn', role: 'note' },
          `This page shows the first ${String(source.text.length)} characters of ${String(source.bytes)} bytes. Review the whole file before you decide: exponetdb migration show ${source.migrationId}.`,
        )
      : null,
  )
}

function pairs(...entries: [string, Child | Child[]][]): HTMLElement {
  return h(
    'dl',
    {},
    ...entries.flatMap(([term, value]) => [
      h('dt', {}, term),
      h('dd', {}, ...(Array.isArray(value) ? value : [value])),
    ]),
  )
}

/** The facts ExponetDB computed for one migration of the plan. */
function migrationFacts(item: Json, analysis: Json | undefined): HTMLElement {
  const compatibility = obj(analysis?.['compatibility'])
  const rollback = obj(analysis?.['rollback'])
  const destructive = arr(analysis?.['destructive']).filter(
    (d): d is string => typeof d === 'string',
  )
  const rewrites = arr(analysis?.['rewriteRisk']).map(obj)
  return h(
    'section',
    { class: 'migration-facts' },
    h('h4', {}, ...foreign(str(item['name']) ?? ''), ` (${str(item['migrationId']) ?? ''})`),
    pairs(
      [
        'Compatibility',
        `declared ${str(compatibility['declared']) ?? 'unknown'}, observed ${str(compatibility['observed']) ?? 'unknown'}${compatibility['agreement'] === false ? ' (they disagree)' : ''}`,
      ],
      ['Strongest lock', str(analysis?.['lockSeverity']) ?? 'unknown'],
      [
        'Statements',
        h(
          'ol',
          { class: 'statements' },
          ...arr(analysis?.['statements']).map((raw) => {
            const st = obj(raw)
            const lock = obj(st['lock'])
            return h(
              'li',
              { class: st['compatibility'] === 'destructive' ? 'destructive' : '' },
              `${str(st['kind']) ?? 'statement'} at line ${String(num(st['line']) ?? '?')}, ${str(lock['mode']) === undefined ? 'no lock' : `lock ${str(lock['mode'])}`}, ${str(st['compatibility']) ?? 'unknown'}`,
            )
          }),
        ),
      ],
      [
        'Drops',
        destructive.length === 0
          ? 'nothing'
          : h(
              'ul',
              {},
              ...destructive.map((d) => h('li', { class: 'destructive' }, ...foreign(d))),
            ),
      ],
      [
        'Table rewrites (estimate)',
        rewrites.length === 0
          ? 'none'
          : h(
              'ul',
              {},
              ...rewrites.map((r) =>
                h(
                  'li',
                  {},
                  ...foreign(str(r['relation']) ?? ''),
                  `: ${num(r['rows']) === undefined ? 'unknown rows' : `${String(num(r['rows']))} rows`}, ${num(r['bytes']) === undefined ? 'unknown size' : `${String(num(r['bytes']))} bytes`}`,
                ),
              ),
            ),
      ],
      [
        'Rollback',
        rollback['available'] === true
          ? `down.sql exists, declared ${str(rollback['declaredSafety']) ?? 'without safety'}`
          : 'none (a failure is not undone automatically)',
      ],
      ['Checksum', h('code', { class: 'hash' }, str(item['checksum']) ?? '')],
    ),
  )
}

const FILES_PER_MIGRATION: Readonly<Record<string, number>> = {
  'migration.apply': 2,
  'migration.resume': 2,
  'migration.rollback': 1,
}

/** The whole review of one plan. */
export function reviewSection(review: Review): HTMLElement {
  const plan = review.plan
  const content = obj(plan.change?.content)
  const analysis = obj(plan.change?.analysis)
  const perMigration = new Map<string, Json>()
  for (const a of arr(analysis['perMigration'])) {
    const id = str(obj(a)['migrationId'])
    if (id !== undefined) perMigration.set(id, obj(a))
  }
  const facts = obj(content['facts'])
  const summary = obj(analysis['summary'])
  const expected = obj(content['expectedState'])
  const actor = plan.actor
  const migrations = arr(content['migrations']).map(obj)
  // The files the server shows per kind (application.ts, REVIEW_FILES); verify.sql is required in a bundle.
  const perItem = FILES_PER_MIGRATION[plan.kind]
  const runs = plan.kind === 'migration.verify' ? 1 : migrations.length * (perItem ?? 0)
  const omitted = Math.max(0, runs - review.sources.length)
  return h(
    'div',
    { class: 'review' },
    h(
      'section',
      { class: 'computed' },
      h('h3', {}, 'What ExponetDB computed'),
      pairs(
        [
          'Target',
          plan.subject.targetPath === null
            ? 'none'
            : [
                h('code', {}, plan.subject.targetPath),
                plan.subject.tier === 'prod'
                  ? h('span', { class: 'badge warn' }, 'production')
                  : h('span', { class: 'badge' }, plan.subject.tier ?? 'unknown tier'),
              ],
        ],
        ['Change', `${plan.kind}, class ${plan.class}`],
        [
          'Created by',
          [
            actor.kind === 'system' ? 'the system' : `${actor.kind} ${actor.identityId}`,
            actor.kind === 'system' ? '' : ` through ${actor.via}`,
            review.clientName === null
              ? null
              : h(
                  'span',
                  { class: 'client-name' },
                  ' (client ',
                  h('q', {}, ...foreign(review.clientName)),
                  ' ',
                  h('span', { class: 'badge warn' }, 'name not verified'),
                  ')',
                ),
          ],
        ],
        [
          'Policy decision',
          [
            h('strong', {}, plan.decision),
            plan.requirements.length === 0
              ? null
              : h(
                  'ul',
                  {},
                  ...plan.requirements.map((r) =>
                    h(
                      'li',
                      {},
                      r.kind === 'approval'
                        ? `${String(r.count)} approval(s) by a person with plans.approve`
                        : r.kind === 'reauth'
                          ? `a fresh re-authentication within ${String(r.withinSeconds)} s`
                          : r.kind,
                    ),
                  ),
                ),
            (plan.policyRules ?? []).length === 0
              ? null
              : h(
                  'ul',
                  { class: 'rules' },
                  ...(plan.policyRules ?? []).map((r) =>
                    h('li', {}, `${r.id} (${r.severity}): ${r.result}. `, r.message),
                  ),
                ),
          ],
        ],
        ...(Object.keys(facts).length === 0
          ? []
          : ([
              [
                'Overall',
                `compatibility ${str(summary['compatibility']) ?? 'unknown'}, strongest lock ${str(summary['lockSeverity']) ?? 'unknown'}${summary['destructive'] === true ? ', drops objects' : ''}${summary['nontransactional'] === true ? ', not in one transaction' : ''}`,
              ],
              ['Staging evidence', str(facts['evidence']) ?? 'unknown'],
              [
                'Schema state',
                [
                  'bound to fingerprint ',
                  h('code', { class: 'hash' }, str(expected['schemaFingerprint']) ?? 'unknown'),
                  '; any change before the apply makes the plan stale',
                ],
              ],
              ['Newest backup', 'not known to ExponetDB (backups arrive with Wave 9)'],
            ] as [string, Child | Child[]][])),
        ['Expires', formatTime(plan.expiresAt)],
        ['Plan hash', h('code', { class: 'hash full-hash' }, plan.planHash)],
      ),
      ...migrations.map((m) => migrationFacts(m, perMigration.get(str(m['migrationId']) ?? ''))),
    ),
    review.sources.length === 0 && omitted === 0
      ? null
      : h(
          'section',
          { class: 'raw' },
          h('h3', {}, 'What the plan runs (raw text, not checked by ExponetDB)'),
          h(
            'p',
            { class: 'hint' },
            'Comments and names below are data from the bundle; no text in them can approve anything or change what the facts above say.',
          ),
          omitted === 0
            ? null
            : h(
                'p',
                { class: 'banner warn', role: 'note' },
                `This page shows ${String(review.sources.length)} of the ${String(runs)} files the plan runs (at most 64). Review the others before you decide: exponetdb migration show <migration>.`,
              ),
          // The statement facts belong to the file the plan executes, never to verify.sql.
          ...review.sources.map((s) =>
            sourceBlock(s, s.file === 'verify.sql' ? undefined : perMigration.get(s.migrationId)),
          ),
        ),
  )
}
