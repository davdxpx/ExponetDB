import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { Scope } from '@exponetdb/contracts'
import { newUlid } from '@exponetdb/kernel'
import {
  createProtocolClient,
  type Exchange,
  Normalizer,
  type ProtocolEra,
  parseTranscript,
  replayTranscript,
  TRANSCRIPT_FORMAT,
  TranscriptRecorder,
} from '@exponetdb/testkit/mcp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bundle, DEFAULTS, type McpWorld, MODERN, mcpWorld } from './support/mcp-int-world.ts'
import { ORIGIN } from './support/node-world.ts'

/**
 * Replay tests (Wave 7 order §29): sessions of the official SDK client
 * (`@exponetdb/testkit/mcp`), recorded as normalized JSON-RPC transcripts
 * in `packages/testkit/fixtures/mcp-replay/`, are sent again to a fresh
 * world and every answer must equal the recording: refusal codes, plan
 * structure, the tool list and its catalog digest, result shapes. The
 * recordings are **synthetic** (scripted sessions of this suite), never
 * presented as a real client's.
 *
 * `EXDB_RECORD_TRANSCRIPTS=1` records them again (after a deliberate change;
 * the diff of the fixture files is then part of the review).
 */
const DIR = new URL('../../../packages/testkit/fixtures/mcp-replay/', import.meta.url)
const RECORD = process.env['EXDB_RECORD_TRANSCRIPTS'] === '1'
const READ: Scope[] = ['targets.read', 'schema.read', 'diagnostics.read', 'migrations.read']

let w: McpWorld
let agentToken: string
let prodToken: string

beforeAll(async () => {
  w = await mcpWorld('exdb_it_mcp_replay')
  const clientId = await w.mcpClient('Replay Agent')
  agentToken = (
    await w.mcpToken(
      clientId,
      [...READ, 'migrations.plan', 'migrations.apply:nonprod', 'data.read:nonprod'],
      ['nonprod'],
    )
  ).access_token
  prodToken = (
    await w.mcpToken(
      clientId,
      [...READ, 'data.read:nonprod', 'data.read:prod'],
      ['nonprod', 'prod'],
    )
  ).access_token
}, 300_000)

afterAll(async () => {
  await w?.stop()
})

/** The per-world literals a transcript names instead of their values. */
function normalizer(): Normalizer {
  return new Normalizer().literal(w.ids.slug, '<slug>')
}

type Session = (
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>,
) => Promise<void>

const SESSIONS: readonly {
  readonly name: string
  readonly era: Exclude<ProtocolEra, 'auto'>
  readonly token: () => string
  readonly run: Session
}[] = [
  {
    name: 'read-tour.modern',
    era: 'modern',
    token: () => agentToken,
    run: async (call) => {
      const target = (await call('target_get', {
        target: `${w.ids.slug}/platform/staging`,
      })) as { structuredContent?: { id?: string } }
      const id = target.structuredContent?.id
      await call('schema_search', { target: id, q: 'accounts' })
      await call('migration_status', { target: id })
      await call('sql_query', {
        target: id,
        sql: 'SELECT count(*) AS n FROM public.accounts',
      })
      await call('sql_cancel', { target: id, queryId: `qry_${newUlid(Date.now())}` })
    },
  },
  {
    name: 'refusals.legacy',
    era: 'legacy',
    token: () => prodToken,
    run: async (call) => {
      const prod = (await call('target_get', {
        target: `${w.ids.slug}/platform/production`,
      })) as { structuredContent?: { id?: string } }
      const staging = (await call('target_get', {
        target: `${w.ids.slug}/platform/staging`,
      })) as { structuredContent?: { id?: string } }
      // OD-13 (a): production rows are for people; a tool error, never a 403.
      await call('sql_query', {
        target: prod.structuredContent?.id,
        sql: 'SELECT count(*) FROM public.accounts',
      })
      await call('sql_query', {
        target: staging.structuredContent?.id,
        sql: 'DELETE FROM public.accounts',
      })
      await call('plan_get', { planId: `pln_${newUlid(Date.now())}` })
      await call('migration_plan', { target: staging.structuredContent?.id, bundles: [] })
      await call('drop_table', { table: 'public.accounts' })
    },
  },
  {
    name: 'plan-staging.modern',
    era: 'modern',
    token: () => agentToken,
    run: async (call) => {
      const target = (await call('target_get', {
        target: `${w.ids.slug}/platform/staging`,
      })) as { structuredContent?: { id?: string } }
      const planned = (await call('migration_plan', {
        target: target.structuredContent?.id,
        bundles: [
          bundle({
            id: newUlid(Date.now()),
            name: 'add-replay-note',
            up: 'ALTER TABLE public.accounts ADD COLUMN replay_note text;\n',
            verify:
              "-- check: replay_note exists\nSELECT count(*) = 1 AS ok FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'replay_note';\n",
          }),
        ],
        defaults: DEFAULTS,
      })) as { structuredContent?: { id?: string } }
      const applied = (await call('plan_apply', { planId: planned.structuredContent?.id })) as {
        structuredContent?: { id?: string }
      }
      await w.drive()
      await call('operation_get', { operationId: applied.structuredContent?.id })
    },
  },
]

async function record(session: (typeof SESSIONS)[number]): Promise<string> {
  const recorder = new TranscriptRecorder(normalizer())
  const { client, close } = await createProtocolClient({
    era: session.era,
    token: session.token(),
    url: `${ORIGIN}/mcp`,
    fetch: async (input, init) => w.app.request(String(input), init),
    recorder,
  })
  try {
    await client.listTools()
    await session.run(async (name, args) => {
      try {
        return await client.callTool({ name, arguments: args })
      } catch (error) {
        // A protocol error (an unknown tool) is part of the transcript already.
        return { protocolError: (error as { code?: number }).code }
      }
    })
  } finally {
    await close()
  }
  return recorder.serialize({
    format: TRANSCRIPT_FORMAT,
    name: session.name,
    era: session.era,
    provenance: {
      kind: 'synthetic',
      producer: `apps/server/test/mcp-replay.int.test.ts with @modelcontextprotocol/client 2.3.1 (${session.era} era${session.era === 'modern' ? `, pinned ${MODERN}` : ''})`,
    },
    fixture: 'apps/server/test/support/mcp-int-world.ts',
  })
}

async function replay(session: (typeof SESSIONS)[number], exchanges: Exchange[]) {
  return replayTranscript(
    exchanges,
    async (method, headers, body) =>
      w.app.request(`${ORIGIN}/mcp`, {
        method,
        headers: {
          ...headers,
          authorization: `Bearer ${session.token()}`,
          accept: 'application/json, text/event-stream',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    {
      normalizer: normalizer(),
      // The worker's turn before an observation, as in the recorded session.
      before: async (body) => {
        const params = (body as { params?: { name?: string } } | undefined)?.params
        if (params?.name === 'operation_get') await w.drive()
      },
    },
  )
}

describe('replay of recorded MCP sessions (synthetic)', () => {
  for (const session of SESSIONS) {
    it(`${session.name} answers as recorded`, async () => {
      const file = new URL(`${session.name}.jsonl`, DIR)
      if (RECORD) {
        await mkdir(DIR, { recursive: true })
        await writeFile(file, await record(session))
        return
      }
      const { header, exchanges } = parseTranscript(await readFile(file, 'utf8'))
      expect(header.provenance.kind).toBe('synthetic')
      expect(exchanges.length).toBeGreaterThan(3)
      const differences = await replay(session, exchanges)
      expect(differences).toEqual([])
    }, 120_000)
  }

  it('reports a changed answer (the replay is not vacuous)', async () => {
    if (RECORD) return
    const session = SESSIONS.find((s) => s.name === 'refusals.legacy')
    if (session === undefined) throw new Error('session')
    const { exchanges } = parseTranscript(
      await readFile(new URL(`${session.name}.jsonl`, DIR), 'utf8'),
    )
    // As if a release answered the production read with another code.
    const tampered = JSON.parse(
      JSON.stringify(exchanges).replaceAll('DATA_READ_NOT_PERMITTED', 'QUERY_TIMEOUT'),
    ) as Exchange[]
    const differences = await replay(session, tampered)
    expect(differences.length).toBeGreaterThan(0)
    expect(differences.join('\n')).toContain('QUERY_TIMEOUT')
  })
})
