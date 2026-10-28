// I1 Determinism: the same bundles produce the same bytes on any machine, Node and Bun version, locale,
// time zone and input order. tools/dump.ts prints a digest of everything deterministic the bundle
// libraries compute (c1 digests, executable text, lint reports for PostgreSQL 16/17/18, statement
// analysis, graph order, a plan hash over a fixed body). It is run as a child process under:
//   runtimes   pinned Node + pinned Bun (on PATH), and when given: B2_NODE_ALT (e.g. Node 26.5.0),
//              B2_BUN_ALT (e.g. Bun 1.3.14)
//   TZ         UTC, Pacific/Kiritimati (+14), America/St_Johns (-03:30), Pacific/Pago_Pago (-11)
//   LANG/LC_ALL C, C.UTF-8, tr_TR.UTF-8 (Turkish: 'I'.toLowerCase() trap; ICU default locale follows the env)
//   order      input order shuffled with three seeds
// Every run must print the same hash. NOTE: the plan hash of a real plan also binds a random plan id and
// timestamps, so two real plans of the same content have different hashes by design; what is
// deterministic is the plan CONTENT (`contentChecksum`), compared in I3-order.int.test.ts.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const DUMP = join(here, 'tools', 'dump.ts')
const TURKISH = join(here, 'tools', 'turkish.mjs')

interface Runtime {
  name: string
  cmd: string
  args: string[]
}
function runtimes(): Runtime[] {
  const list: Runtime[] = [
    { name: 'node-pinned', cmd: process.env['B2_NODE'] ?? 'node', args: ['--conditions=@exponetdb/source'] },
    { name: 'bun-pinned', cmd: process.env['B2_BUN'] ?? 'bun', args: ['--conditions=@exponetdb/source'] },
  ]
  const nodeAlt = process.env['B2_NODE_ALT']
  const bunAlt = process.env['B2_BUN_ALT']
  if (nodeAlt && existsSync(nodeAlt)) list.push({ name: 'node-alt', cmd: nodeAlt, args: ['--conditions=@exponetdb/source'] })
  if (bunAlt && existsSync(bunAlt)) list.push({ name: 'bun-alt', cmd: bunAlt, args: ['--conditions=@exponetdb/source'] })
  return list
}

interface Env {
  label: string
  env: Record<string, string>
  shuffle?: number
  turkish?: boolean
}
const ENVS: Env[] = [
  { label: 'TZ=UTC LANG=C', env: { TZ: 'UTC', LANG: 'C', LC_ALL: 'C' } },
  { label: 'TZ=Pacific/Kiritimati LANG=C.UTF-8', env: { TZ: 'Pacific/Kiritimati', LANG: 'C.UTF-8', LC_ALL: '' } },
  { label: 'TZ=America/St_Johns LANG=tr_TR.UTF-8', env: { TZ: 'America/St_Johns', LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8' } },
  { label: 'TZ=Pacific/Pago_Pago LANG=tr_TR.UTF-8 LANGUAGE=tr', env: { TZ: 'Pacific/Pago_Pago', LANG: 'tr_TR.UTF-8', LANGUAGE: 'tr', LC_ALL: '' } },
  { label: 'Turkish case folding armed (preload)', env: { TZ: 'UTC', LANG: 'C' }, turkish: true },
  { label: 'shuffle 1', env: { TZ: 'UTC', LANG: 'C.UTF-8' }, shuffle: 1 },
  { label: 'shuffle 777', env: { TZ: 'America/St_Johns', LANG: 'C' }, shuffle: 777 },
  { label: 'shuffle 424242', env: { TZ: 'Pacific/Kiritimati', LANG: 'tr_TR.UTF-8' }, shuffle: 424242 },
]

interface Out {
  hash: string
  sections: Record<string, string>
  lintRaw: string
  trap: { lowerI: string; collator: string }
}
function run(rt: Runtime, e: Env): Out {
  const preload = e.turkish === true ? (rt.name.startsWith('bun') ? ['--preload', TURKISH] : ['--import', TURKISH]) : []
  const args = [...rt.args, ...preload, DUMP, ...(e.shuffle === undefined ? [] : ['--shuffle', String(e.shuffle)])]
  const r = spawnSync(rt.cmd, args, {
    env: { ...process.env, ...e.env },
    encoding: 'utf8',
    timeout: 240_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (r.status !== 0) throw new Error(`${rt.name} [${e.label}] exit ${r.status}: ${(r.stderr || r.stdout).slice(0, 800)}`)
  const line = r.stdout.trim().split('\n').at(-1) ?? '{}'
  return JSON.parse(line) as Out
}

describe('I1 same bytes on every runtime, time zone, locale and input order', () => {
  const rts = runtimes()
  const results = new Map<string, Out>()

  for (const rt of rts) {
    for (const e of ENVS) {
      test(`${rt.name} [${e.label}]`, () => {
        results.set(`${rt.name}|${e.label}`, run(rt, e))
        expect(results.get(`${rt.name}|${e.label}`)?.hash).toMatch(/^[0-9a-f]{64}$/)
      })
    }
  }

  test('all runs produced one single hash (digests, analysis, graph, plan hash, canonical lint)', () => {
    const hashes = new Map<string, string[]>()
    const real = [...results.entries()].filter(([k]) => !k.includes('Turkish'))
    for (const [k, v] of real) hashes.set(v.hash, [...(hashes.get(v.hash) ?? []), k])
    expect(results.size, 'every matrix cell ran').toBe(rts.length * ENVS.length)
    expect([...hashes.entries()].map(([h, ks]) => `${h.slice(0, 12)}: ${ks.join(' ; ')}`), 'distinct hashes').toHaveLength(1)
  })

  test('the raw lint report (finding order) is identical across runtimes, zones and locales for the SAME input order', () => {
    const base = [...results.entries()].filter(([k]) => !k.includes('shuffle') && !k.includes('Turkish'))
    const hashes = new Set(base.map(([, v]) => v.lintRaw))
    expect(base.length).toBeGreaterThan(0)
    expect([...hashes], 'distinct raw lint hashes without shuffling').toHaveLength(1)
  })

  test('FINDING: the lint report does not depend on the order the bundles are submitted in', () => {
    const plain = [...results.entries()].find(([k]) => k.startsWith('node-pinned|TZ=UTC LANG=C'))?.[1]
    const shuffled = [...results.entries()].filter(([k]) => k.includes('shuffle')).map(([, v]) => v.lintRaw)
    expect(plain).toBeDefined()
    // `parallel_object_overlap` names "the other migration" in whatever order the bundles arrive.
    expect(new Set([plain?.lintRaw, ...shuffled]).size, 'raw lint reports for shuffled input').toBe(1)
  })

  test('the case-folding trap: frozen outputs (c1 digests, graph order, plan hash) do not change when toLowerCase/toUpperCase follow the Turkish rules', () => {
    const armed = [...results.entries()].filter(([k]) => k.includes('Turkish case folding armed'))
    expect(armed.length).toBe(rts.length)
    const reference = [...results.entries()].find(([k]) => k.startsWith('node-pinned|TZ=UTC LANG=C'))?.[1]
    for (const [k, v] of armed) {
      for (const section of ['digests', 'graph', 'planHash']) {
        expect(v.sections[section], `${k}: section ${section}`).toBe(reference?.sections[section])
      }
    }
    // Characterisation (not an assertion): statement analysis and lint do change, i.e. the analyzer lowercases
    // identifiers with the standard toLowerCase (locale independent in every runtime). tr_TR.UTF-8 is not
    // installed on this machine and ICU's default locale stays en-US, so LANG alone cannot arm the trap.
    const changed = armed.filter(([, v]) => v.sections['analysis'] !== reference?.sections['analysis']).map(([k]) => k.split('|')[0])
    console.log(`I1: with Turkish case folding forced, analysis output differs in: ${[...new Set(changed)].join(', ') || 'none'}`)
  })
})
