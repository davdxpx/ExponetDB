import { describe, expect, it } from 'vitest'
import {
  CLIENT_IDS,
  clientGuides,
  connectSearch,
  isClientId,
  mcpServerUrl,
  shellWord,
} from '../../src/features/connect/clients.ts'

const URL = 'https://db.exponet.cloud/mcp'

function snippets(url: string) {
  return clientGuides(url).flatMap((guide) =>
    guide.steps.flatMap((step) =>
      step.blocks.flatMap((block) =>
        block.kind === 'snippet' ? [{ client: guide.id, ...block }] : [],
      ),
    ),
  )
}

describe('the MCP clients of the connect page', () => {
  it('lists the five target clients by name, without logos', () => {
    expect(clientGuides(URL).map((g) => [g.id, g.name, g.kind])).toEqual([
      ['claude-code', 'Claude Code', 'cli'],
      ['claude', 'Claude', 'web'],
      ['cursor', 'Cursor', 'ide'],
      ['codex', 'Codex', 'cli'],
      ['vscode', 'VS Code', 'ide'],
    ])
    expect(CLIENT_IDS).toEqual(clientGuides(URL).map((g) => g.id))
  })

  it('builds the server URL from the origin only', () => {
    expect(mcpServerUrl('https://db.exponet.cloud')).toBe(URL)
    expect(mcpServerUrl('http://localhost:8480')).toBe('http://localhost:8480/mcp')
  })

  it('puts the URL into every configuration as valid JSON or TOML', () => {
    for (const snippet of snippets(URL)) {
      if (snippet.language === 'json') {
        expect(JSON.stringify(JSON.parse(snippet.text))).toContain(URL)
      }
      if (snippet.language === 'toml') {
        expect(snippet.text).toContain(`url = "${URL}"`)
        expect(snippet.text).toContain(`oauth_resource = "${URL}"`)
        expect(snippet.text).toContain(
          'scopes = ["targets.read", "schema.read", "diagnostics.read"]',
        )
      }
    }
    const commands = snippets(URL)
      .filter((s) => s.language === 'shell')
      .map((s) => s.text)
    expect(commands).toContain(`claude mcp add --transport http exponetdb ${URL}`)
    expect(commands).toContain(`code --add-mcp '{"name":"exponetdb","type":"http","url":"${URL}"}'`)
  })

  it('quotes anything a shell would read as more than one word', () => {
    expect(shellWord(URL)).toBe(URL)
    expect(shellWord('http://[::1]:8480/mcp')).toBe("'http://[::1]:8480/mcp'")
    expect(shellWord("it's; rm -rf /")).toBe(`'it'\\''s; rm -rf /'`)
    const odd = 'http://host$(touch x)/mcp'
    const vscode = snippets(odd).find((s) => s.text.startsWith('code --add-mcp'))
    expect(vscode?.text).toBe(`code --add-mcp '{"name":"exponetdb","type":"http","url":"${odd}"}'`)
    const claude = snippets(odd).find((s) => s.text.startsWith('claude mcp add'))
    expect(claude?.text).toBe(`claude mcp add --transport http exponetdb '${odd}'`)
  })

  it('accepts only the listed client ids in the address', () => {
    expect(connectSearch({ client: 'cursor' })).toEqual({ client: 'cursor' })
    for (const value of [
      'evil',
      '<script>',
      'CURSOR',
      '',
      1,
      null,
      ['cursor'],
      { a: 1 },
      '__proto__',
    ]) {
      // The key is there and undefined, so it replaces the raw value the router merges under it.
      expect(connectSearch({ client: value })).toStrictEqual({ client: undefined })
      expect(isClientId(value)).toBe(false)
    }
    expect(connectSearch({})).toStrictEqual({ client: undefined })
  })
})
