import { newId } from '@exponetdb/kernel'
import { describe, expect, it } from 'vitest'
import {
  denormalize,
  firstDifference,
  messagesOf,
  Normalizer,
  parseTranscript,
  TRANSCRIPT_FORMAT,
  TranscriptRecorder,
} from '../src/mcp/index.ts'

describe('MCP transcripts (replay, Wave 7 order §29)', () => {
  it('numbers per-run values by first appearance and keeps the catalog digest exact', () => {
    const n = new Normalizer()
    const target = newId('tgt', Date.now())
    const digest = `sha256:${'a'.repeat(64)}`
    const out = n.value({
      id: target,
      again: `target ${target} at 2026-10-13T08:00:00.123Z`,
      planHash: `sha256:${'b'.repeat(64)}`,
      durationMs: 42,
      nextCursor: 'sealed-cursor',
      text: '<<<exponetdb-data-41c7c42b2bb8 {"queryId":"qry_01M4SES0JPRDA4GYYFDVTGCQAP"} exponetdb-data-41c7c42b2bb8>>>',
      _meta: { 'cloud.exponet.db/catalogDigest': digest },
      directory: '01M4SFK7C8SRH3QB4R8J9SCW3G_add-replay-note',
      quoted: '{"durationMs":17,"nextCursor":"abc"}',
    })
    expect(out).toEqual({
      id: '<tgt:1>',
      again: 'target <tgt:1> at <time>',
      planHash: '<sha256:1>',
      durationMs: 0,
      nextCursor: '<nextCursor>',
      text: '<<<exponetdb-data-<marker> {"queryId":"<qry:1>"} exponetdb-data-<marker>>>>',
      _meta: { 'cloud.exponet.db/catalogDigest': digest },
      directory: '<ulid:1>_add-replay-note',
      quoted: '{"durationMs":0,"nextCursor":"<nextCursor>"}',
    })
    expect(n.resolve('<tgt:1>')).toBe(target)
  })

  it('resolves placeholders of a replayed request and mints fresh ids the client chose', () => {
    const n = new Normalizer()
    const target = newId('tgt', Date.now())
    n.value({ id: target })
    const request = denormalize({ target: '<tgt:1>', queryId: '<qry:1>' }, n) as Record<
      string,
      string
    >
    expect(request['target']).toBe(target)
    expect(request['queryId']).toMatch(/^qry_[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
    // The fresh id is bound: its next appearance maps to the same placeholder.
    expect(n.value(request['queryId'])).toBe('<qry:1>')
  })

  it('reads JSON bodies and event streams, and serializes a parseable transcript', async () => {
    expect(messagesOf('application/json', '{"jsonrpc":"2.0","id":1,"result":{}}')).toEqual([
      { jsonrpc: '2.0', id: 1, result: {} },
    ])
    expect(
      messagesOf('text/event-stream', 'event: message\ndata: {"a":1}\n\ndata: {"b":2}\n\n'),
    ).toEqual([{ a: 1 }, { b: 2 }])
    const recorder = new TranscriptRecorder()
    const fetchLike = recorder.wrap(
      async () =>
        new Response('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}', {
          headers: { 'content-type': 'application/json' },
        }),
    )
    await fetchLike('http://x/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer secret-token', 'mcp-method': 'tools/list' },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    })
    const text = recorder.serialize({
      format: TRANSCRIPT_FORMAT,
      name: 'unit',
      era: 'modern',
      provenance: { kind: 'synthetic', producer: 'unit test' },
      fixture: 'none',
    })
    // The token travels in a header the recorder never keeps.
    expect(text).not.toContain('secret-token')
    const parsed = parseTranscript(text)
    expect(parsed.exchanges[0]?.request.headers).toEqual({ 'mcp-method': 'tools/list' })
    expect(parsed.exchanges[0]?.request.method).toBe('POST')
    expect(parsed.exchanges[0]?.response).toEqual({
      status: 200,
      messages: [{ jsonrpc: '2.0', id: 1, result: { ok: true } }],
    })
  })

  it('names the first difference', () => {
    expect(firstDifference({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(
      '/a/1/b: expected 2, got 3',
    )
    expect(firstDifference({ a: 1 }, { a: 1 })).toBeUndefined()
  })
})
