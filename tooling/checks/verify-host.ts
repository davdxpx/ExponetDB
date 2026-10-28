/**
 * What `bun run verify` does not run (test campaign TC-029): the exact commands of the test classes
 * that need a systemd host, root, Docker or an API key, and the CI job that runs each. `verify` is
 * not the full proof; this list is the other part of it. Run with `--list` for one command per
 * line. The script prints, it never runs them: they need root and a disposable host. It fails when
 * a file it names is gone, so the list cannot rot unnoticed.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

interface Entry {
  readonly what: string
  /** Paths (files or directories) that hold the tests; checked to exist. */
  readonly paths: readonly string[]
  readonly needs: string
  readonly command: string
  readonly ci: string
}

const CLUSTERS = 'EXDB_NODE_CLUSTERS=<from tooling/dev/node-clusters.sh>'
const PG = 'EXDB_TEST_PG_URL=<a PostgreSQL 17 URL>'

export const ENTRIES: readonly Entry[] = [
  {
    what: 'Host scenarios (the real agent and helper under systemd, one scenario per run)',
    paths: ['apps/server/test/host', 'apps/server/vitest.host.config.ts'],
    needs: 'Linux with systemd, root, PostgreSQL 17 clusters (tooling/dev/node-clusters.sh)',
    command: `sudo -E env "PATH=$PATH" ${PG} ${CLUSTERS} EXDB_NODE_E2E_AGENT_USER=<agent user> bun run --cwd apps/server test:host test/host/<scenario>.host.test.ts`,
    ci: 'node-host-scenarios',
  },
  {
    what: 'Capability operations end to end under systemd',
    paths: ['apps/server/test/agent-capabilities.host.test.ts'],
    needs: 'as above',
    command: `sudo -E env "PATH=$PATH" ${PG} ${CLUSTERS} bun run --cwd apps/server test:host test/agent-capabilities.host.test.ts`,
    ci: 'node-pg',
  },
  {
    what: 'Go wire client and capabilities against real clusters (tag pgit)',
    paths: ['agent/node/internal/pgwire', 'agent/node/internal/capabilities'],
    needs: 'root, PostgreSQL 16, 17, 18 clusters',
    command: `cd agent/node && sudo -E env "PATH=$PATH" ${CLUSTERS} go test -race -count=1 -tags pgit ./internal/pgwire ./internal/capabilities`,
    ci: 'node-pg',
  },
  {
    what: 'Backup and restore lab: the root helper against pgBackRest, restic and PostgreSQL 17 (tag pglab)',
    paths: ['agent/node/internal/helper/pglab_test.go'],
    needs: 'root, pgBackRest >= 2.59.3, restic, PostgreSQL 17 under /usr/lib/postgresql/17',
    command:
      'cd agent/node && sudo -E env "PATH=$PATH" go test -tags pglab -count=1 -run TestPglab -v ./internal/helper',
    ci: 'backup-lab',
  },
  {
    what: 'The offline restore from the generated runbook (C-35)',
    paths: ['packages/backups/test/runbook.lab.test.ts', 'packages/backups/vitest.lab.config.ts'],
    needs: 'root, pgBackRest, PostgreSQL 17',
    command: 'sudo -E env "PATH=$PATH" bun run --cwd packages/backups test:lab',
    ci: 'backup-lab',
  },
  {
    what: 'The packed CLI installed outside the repository',
    paths: ['apps/cli/test/packed.install.test.ts', 'apps/cli/vitest.install.config.ts'],
    needs: 'a built CLI, PostgreSQL for the stack',
    command: 'bun run --cwd apps/cli test:install',
    ci: 'postgres',
  },
  {
    what: 'The local test lab on the Docker daemon (quickstart, Traefik, MCP stability, CLI dev lab)',
    paths: ['apps/server/vitest.lab.config.ts', 'apps/cli/vitest.lab.config.ts'],
    needs: 'Docker',
    command: 'bun run --cwd apps/server test:lab; bun run --cwd apps/cli test:lab',
    ci: 'image',
  },
  {
    what: 'MCP evals with a model (the *.model.test.ts class)',
    paths: ['apps/server/test/mcp-evals.model.test.ts', 'apps/server/vitest.evals.config.ts'],
    needs: 'ANTHROPIC_API_KEY; without it the run says it was skipped and exits 0',
    command: 'bun run mcp:evals',
    ci: 'none (owner, with a key)',
  },
]

function main(): number {
  const root = join(import.meta.dirname, '..', '..')
  const missing = ENTRIES.flatMap((e) => e.paths.filter((p) => !existsSync(join(root, p))))
  if (missing.length > 0) {
    console.error(`verify:host names files that no longer exist: ${missing.join(', ')}`)
    return 1
  }
  if (process.argv.includes('--list')) {
    for (const e of ENTRIES) console.log(e.command)
    return 0
  }
  console.log(
    '`bun run verify` does not run these; each needs the host named, and CI runs them as listed.\n',
  )
  for (const e of ENTRIES) {
    console.log(`${e.what}\n  needs: ${e.needs}\n  CI job: ${e.ci}\n  run:   ${e.command}\n`)
  }
  return 0
}

if (import.meta.main) process.exitCode = main()
