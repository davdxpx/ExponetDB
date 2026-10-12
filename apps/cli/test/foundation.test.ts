import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse, parseDuration, UsageError } from '../src/cli/args.ts'
import { EXIT, exitFor } from '../src/cli/exit.ts'
import { type CommandSpec, commandName } from '../src/cli/spec.ts'
import { COMMANDS } from '../src/commands/index.ts'
import { completionScript } from '../src/local/completion.ts'
import { run } from '../src/main.ts'
import { OUTPUT_SCHEMA, result } from '../src/output/model.ts'
import { renderHuman, renderJson, renderNdjson, type Terminal } from '../src/output/render.ts'
import { clean, cleanLine, truncate, width } from '../src/output/text.ts'
import { testIo } from './support.ts'

/**
 * The CLI foundation without a server: the registry (every command has
 * help and dispatches), the parser, terminal safety, the renderer at
 * several widths, the output contract and the exit codes.
 */
let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'exdb-cli-f-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const noNetwork: typeof fetch = () => Promise.reject(new Error('no network in this test'))

async function cli(argv: readonly string[], extra: Partial<Parameters<typeof testIo>[0]> = {}) {
  const stdout: string[] = []
  const stderr: string[] = []
  const code = await run(
    argv,
    testIo({ configDir: join(dir, 'config'), fetch: noNetwork, stdout, stderr, ...extra }),
  )
  return { code, stdout: stdout.join(''), stderr: stderr.join('') }
}

describe('the command registry', () => {
  it('has unique names and aliases, and every command has help that names it', async () => {
    const names = COMMANDS.flatMap((c) => [c.path, ...(c.aliases ?? [])].map((p) => p.join(' ')))
    expect(new Set(names).size).toBe(names.length)
    for (const c of COMMANDS) {
      const help = await cli([...c.path, '--help'])
      expect(help.code, commandName(c)).toBe(0)
      expect(help.stdout).toContain(`Usage: exponetdb ${commandName(c)}`)
      expect(help.stdout).toContain(c.summary)
      if (c.locality === 'remote') expect(help.stdout).toContain('Runs: against the server')
    }
  })

  it('lists every command (and only them) in `commands --json`', async () => {
    const out = await cli(['commands', '--json'])
    expect(out.code).toBe(0)
    const doc = JSON.parse(out.stdout)
    expect(doc.schema).toBe(OUTPUT_SCHEMA)
    expect(doc.data.items.map((i: { command: string }) => i.command)).toEqual(
      COMMANDS.map(commandName),
    )
  })

  it('shows root and group help without a command, and refuses an unknown one with a suggestion', async () => {
    const root = await cli([])
    expect(root.code).toBe(0)
    expect(root.stdout).toContain('Usage: exponetdb <command>')
    const group = await cli(['profile'])
    expect(group.code).toBe(0)
    expect(group.stdout).toContain('profile add')
    const typo = await cli(['profle', 'list'])
    expect(typo.code).toBe(EXIT.usage)
    expect(typo.stderr).toContain('Unknown command: profle list')
    expect(typo.stderr).toContain('Did you mean: exponetdb profile list')
  })

  it('prints the version without the network', async () => {
    for (const argv of [['--version'], ['version']]) {
      const out = await cli(argv)
      expect(out.code).toBe(0)
      expect(out.stdout).toMatch(/0\.6\.0/)
    }
    const json = JSON.parse((await cli(['version', '-o', 'json'])).stdout)
    expect(json.data).toMatchObject({
      version: '0.6.0',
      commit: 'source',
      outputSchema: OUTPUT_SCHEMA,
    })
  })

  it('generates completion scripts from the registry (no network on Tab)', () => {
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const script = completionScript(shell, COMMANDS)
      expect(script).toContain('profile')
      expect(script).toContain('whoami')
      expect(script).not.toMatch(/curl|wget|fetch|exponetdb (login|whoami)/)
    }
    const bad: CommandSpec = { ...(COMMANDS[0] as CommandSpec), path: ['x;rm'] }
    expect(() => completionScript('bash', [bad])).toThrow()
  })
})

describe('the argument parser', () => {
  const spec: CommandSpec = {
    path: ['thing', 'do'],
    summary: 'Test.',
    group: 'general',
    args: [{ name: 'id', description: 'An id.', required: true }],
    flags: [
      { name: 'limit', type: 'number', description: 'n' },
      { name: 'mode', type: 'enum', values: ['fast', 'safe'], description: 'm' },
      { name: 'wait', type: 'duration', description: 'w' },
      { name: 'tags', type: 'list', description: 't' },
      { name: 'force', type: 'boolean', description: 'f' },
    ],
    locality: 'local',
    effect: 'local',
    output: 'X',
    run: async () => result({ command: 'thing do' }),
  }

  it('takes global flags anywhere, --flag=value, -- and negative numbers', () => {
    const p = parse(
      [spec],
      [
        '--json',
        'thing',
        '--server',
        'https://a.test',
        'do',
        'x1',
        '--limit=-3',
        '--mode',
        'safe',
        '--wait',
        '2m',
        '--tags',
        'a, b',
        '-q',
      ],
    )
    expect(p.command?.path).toEqual(['thing', 'do'])
    expect(p.input.args['id']).toBe('x1')
    expect(p.input.flags).toMatchObject({
      limit: -3,
      mode: 'safe',
      wait: 120_000,
      tags: ['a', 'b'],
    })
    expect(p.global).toMatchObject({ output: 'json', server: 'https://a.test', quiet: true })
    const dashes = parse([spec], ['thing', 'do', '--', '--force'])
    expect(dashes.input.args['id']).toBe('--force')
    expect(dashes.input.flags['force']).toBeUndefined()
  })

  it('refuses unknown flags with a suggestion, missing values, bad enums and conflicting repeats', () => {
    const refuse = (argv: string[]) => {
      try {
        parse([spec], argv)
      } catch (e) {
        if (e instanceof UsageError) return [e.message, e.suggestion]
        throw e
      }
      throw new Error('accepted')
    }
    expect(refuse(['thing', 'do', 'x', '--limt', '1'])).toEqual(['Unknown flag: --limt', '--limit'])
    expect(refuse(['thing', 'do', 'x', '--limit'])[0]).toBe('--limit needs a value.')
    expect(refuse(['thing', 'do', 'x', '--mode', 'fsat'])).toEqual([
      '--mode is one of fast, safe.',
      '--mode fast',
    ])
    expect(refuse(['thing', 'do', 'x', '--limit', '1', '--limit', '2'])[0]).toContain('given twice')
    expect(refuse(['thing', 'do'])[0]).toBe('Missing argument <id>.')
    expect(refuse(['thing', 'do', 'x', 'y'])[0]).toBe('Unexpected argument: y')
    expect(refuse(['thing', 'do', 'x', '--json', '-o', 'table'])[0]).toBe(
      '--json and --output disagree.',
    )
  })

  it('reads durations', () => {
    expect(parseDuration('250ms')).toBe(250)
    expect(parseDuration('30')).toBe(30_000)
    expect(parseDuration('1h')).toBe(3_600_000)
    expect(parseDuration('1d')).toBeUndefined()
    expect(parseDuration('-1s')).toBeUndefined()
  })
})

describe('terminal safety', () => {
  const hostile = [
    'a\u001b[2J\u001b[Hb', // clear screen, cursor home
    'c\u001b]8;;https://evil.test\u0007link\u001b]8;;\u0007d', // OSC 8 hyperlink
    'e\u001b]52;c;Y2xpcA==\u0007f', // OSC 52 clipboard
    'g\u001bP+q\u001b\\h', // DCS
    'i\u009b31mj', // 8-bit CSI
    'k\u009d0;title\u009cl', // 8-bit OSC
    'm‮evil‬n', // bidi override
    'o⁦p⁩q', // isolates
    'r\u0007\u0008s\u007f', // BEL, BS, DEL
  ]

  it('removes escape sequences, C1 controls and bidi steering, and keeps the text', () => {
    expect(hostile.map(clean)).toEqual([
      'ab',
      'clinkd',
      'ef',
      'gh',
      'ij',
      'kl',
      'meviln',
      'opq',
      'rs',
    ])
    expect(clean('tab\there\nnext')).toBe('tab\there\nnext')
    expect(cleanLine('one\ntwo\tthree')).toBe('one two three')
  })

  it('measures width by grapheme and truncates with a visible mark', () => {
    expect(width('abc')).toBe(3)
    expect(width('数据库')).toBe(6)
    expect(width('é')).toBe(1)
    expect(width('👍🏽')).toBe(2)
    expect(truncate('数据库数据库', 7)).toBe('数据库…')
    expect(truncate('abcdef', 4, true)).toBe('abc~')
    expect(truncate('abc', 3)).toBe('abc')
  })

  it('renders hostile remote text inert in every format', () => {
    const r = result({
      command: 'x',
      data: { name: hostile[1] },
      items: [{ name: hostile[0] }],
      blocks: [
        { kind: 'header', title: hostile[2] ?? '', context: [['Server', hostile[3] ?? '']] },
        { kind: 'fields', rows: [['Name', hostile[4] ?? '']] },
        { kind: 'table', columns: [{ title: 'NAME' }], rows: [[hostile[6] ?? '']] },
      ],
      error: { code: 'X', message: hostile[5] ?? '', remediation: hostile[7] ?? '' },
      next: [hostile[8] ?? ''],
    })
    const { out, err } = renderHuman(r, { columns: 80, color: false, ascii: false, quiet: false })
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the test looks for control characters
    const controls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/
    for (const line of [...out, ...err]) expect(line).not.toMatch(controls)
    // JSON escapes them (data stays data); the document is one line of valid JSON per record.
    for (const line of renderNdjson(r, {})) expect(line).not.toMatch(controls)
    expect(renderJson(r, {})).not.toMatch(controls)
  })
})

describe('the human renderer', () => {
  const r = result({
    command: 'thing list',
    blocks: [
      {
        kind: 'header',
        title: 'Targets',
        context: [
          ['Server', 'https://db.example.test'],
          ['Profile', 'local'],
          ['Installation', 'ins_01M4QPP4T3E31ANKDVSR7T3YHS'],
        ],
      },
      {
        kind: 'table',
        columns: [
          { title: 'ID' },
          { title: 'NAME', flexible: true },
          { title: 'TIER' },
          { title: 'STATE' },
        ],
        rows: [
          [
            'tgt_01M4QPP4T3E31ANKDVSR7T3YHS',
            'Customer analytics warehouse (Frankfurt, primary)',
            'prod',
            'active',
          ],
          ['tgt_01M4QN37EYQ6X0NFPAQRPK5FAG', 'Staging', 'nonprod', 'suspended'],
        ],
      },
      {
        kind: 'fields',
        rows: [
          ['Plan', 'pln_01M4QN37EYQ6X0NFPAQRPK5FAG'],
          ['Note', null],
        ],
      },
    ],
  })

  for (const columns of [40, 60, 80, 120]) {
    it(`fits ${columns} columns without losing an id`, () => {
      const terminal: Terminal = { columns, color: false, ascii: false, quiet: false }
      const { out } = renderHuman(r, terminal)
      for (const line of out) expect(width(line), line).toBeLessThanOrEqual(Math.max(columns, 80))
      const text = out.join('\n')
      expect(text).toContain('tgt_01M4QPP4T3E31ANKDVSR7T3YHS')
      expect(text).toContain('pln_01M4QN37EYQ6X0NFPAQRPK5FAG')
      if (columns >= 80)
        for (const line of out) expect(width(line), line).toBeLessThanOrEqual(columns)
    })
  }

  it('says unknown for a missing value and uses no color without a terminal', () => {
    const { out } = renderHuman(r, { columns: 120, color: false, ascii: true, quiet: false })
    expect(out.join('\n')).toContain('Note:')
    expect(out.join('\n')).toMatch(/Note:\s+unknown/)
    expect(out.join('\n')).not.toContain('\u001b')
  })
})

describe('the output contract', () => {
  it('prints exactly one JSON document, with hints kept off stdout', async () => {
    const out = await cli([
      'profile',
      'add',
      'local',
      '--server',
      'https://db.example.test',
      '--use',
      '--json',
    ])
    expect(out.code).toBe(0)
    const doc = JSON.parse(out.stdout)
    expect(doc).toMatchObject({
      schema: OUTPUT_SCHEMA,
      command: 'profile add',
      status: 'ok',
      data: { name: 'local', current: true },
    })
    expect(doc.next).toEqual(['exponetdb login --profile local'])
  })

  it('prints NDJSON items then one final record', async () => {
    await cli(['profile', 'add', 'a', '--server', 'https://a.example.test'])
    await cli(['profile', 'add', 'b', '--server', 'https://b.example.test'])
    const out = await cli(['profile', 'list', '-o', 'ndjson'])
    const records = out.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(records.map((r) => r.type)).toEqual(['item', 'item', 'result'])
    expect(records.every((r) => r.schema === OUTPUT_SCHEMA)).toBe(true)
    expect(records[0].data.name).toBe('a')
  })

  it('reports an error as an error record with its exit code', async () => {
    const out = await cli(['profile', 'remove', 'nope', '--output', 'ndjson'])
    expect(out.code).toBe(EXIT.usage)
    const last = JSON.parse(out.stdout.trim().split('\n').at(-1) ?? '')
    expect(last).toMatchObject({ type: 'error', error: { code: 'usage' } })
  })

  it('follows EXPONETDB_OUTPUT and the profile default, and flags win', async () => {
    await cli([
      'profile',
      'add',
      'p',
      '--server',
      'https://p.example.test',
      '--default-output',
      'json',
      '--use',
    ])
    const shown = (await cli(['profile', 'show'])).stdout
    expect(() => JSON.parse(shown)).not.toThrow()
    expect((await cli(['profile', 'show', '-o', 'table'])).stdout).toMatch(
      /Profile:\s+p \(current\)/,
    )
    const env = await cli(['profile', 'show'], { env: { EXPONETDB_OUTPUT: 'ndjson' } })
    expect(JSON.parse(env.stdout.trim()).type).toBe('result')
  })
})

describe('profiles', () => {
  it('stores profiles privately, switches and removes them, and never stores a token', async () => {
    expect(
      (await cli(['profile', 'add', 'one', '--server', 'https://one.example.test/'])).code,
    ).toBe(0)
    expect(
      (
        await cli([
          'profile',
          'add',
          'two',
          '--server',
          'https://two.example.test',
          '--auth',
          'api-key',
          '--key-file',
          'k.txt',
        ])
      ).code,
    ).toBe(0)
    const path = join(dir, 'config', 'profiles.json')
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe('600')
    const shown = JSON.parse((await cli(['profile', 'show', 'two', '--json'])).stdout)
    expect(shown.data).toMatchObject({
      server: 'https://two.example.test',
      auth: { method: 'api-key', keyFile: join(dir, 'config', 'k.txt') },
    })
    expect((await cli(['profile', 'add', 'one', '--server', 'https://x.example.test'])).code).toBe(
      EXIT.usage,
    )
    expect((await cli(['profile', 'use', 'two'])).code).toBe(0)
    expect(
      JSON.parse((await cli(['profile', 'list', '--json'])).stdout).data.items.find(
        (p: { current: boolean }) => p.current,
      ).name,
    ).toBe('two')
    expect((await cli(['profile', 'remove', 'two'])).code).toBe(0)
    expect(
      (await cli(['profile', 'add', 'Bad_Name', '--server', 'https://x.example.test'])).code,
    ).toBe(EXIT.usage)
    expect((await cli(['profile', 'add', 'h', '--server', 'http://db.example.test'])).code).toBe(
      EXIT.usage,
    )
  })

  it('refuses a named profile with another --server', async () => {
    await cli(['profile', 'add', 'one', '--server', 'https://one.example.test'])
    const out = await cli(['whoami', '--profile', 'one', '--server', 'https://two.example.test'])
    expect(out.code).toBe(EXIT.usage)
    expect(out.stderr).toContain('The profile one belongs to https://one.example.test')
  })
})

describe('exit codes', () => {
  it('maps the error catalog to the documented codes', () => {
    expect(exitFor('INSUFFICIENT_SCOPE')).toBe(3)
    expect(exitFor('REAUTH_REQUIRED')).toBe(3)
    expect(exitFor('APPROVAL_REQUIRED')).toBe(4)
    expect(exitFor('STAGING_EVIDENCE_MISSING')).toBe(4)
    expect(exitFor('TRANSPORT_FAILED')).toBe(5)
    expect(exitFor('installation_changed')).toBe(5)
    expect(exitFor('OUTCOME_UNKNOWN')).toBe(6)
    expect(exitFor('VALIDATION_FAILED')).toBe(2)
    expect(exitFor('MIGRATION_CHECKSUM_MISMATCH')).toBe(1)
  })

  it('exits 5 when the server cannot be reached', async () => {
    const out = await cli(['whoami', '--server', 'https://db.example.test'])
    expect(out.code).toBe(EXIT.unavailable)
  })
})
