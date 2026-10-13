import { mkdir, writeFile } from 'node:fs/promises'
import { type GradedRun, messagesApiAgent, score, transcriptLine } from '@exponetdb/testkit/mcp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runTask } from './support/eval-run.ts'
import { EVAL_HOLDOUT, EVAL_TASKS, verdictText } from './support/eval-tasks.ts'
import { type McpWorld, mcpWorld } from './support/mcp-int-world.ts'

/**
 * Model evals (Wave 7 order §29, layers B and C): a model works on the eval
 * tasks through `/mcp` of the test composition, the same tasks and graders
 * as `mcp-evals.int.test.ts`. Run by the owner with their own key:
 *
 *   EXDB_EVAL_ANTHROPIC_API_KEY=… bun run mcp:evals
 *
 * Optional: `EXDB_EVAL_MODEL` (default `claude-haiku-5-5`, a low-cost model),
 * `EXDB_EVAL_RUNS` (default 3), `EXDB_EVAL_SPLIT` (`tuning`, `holdout` or
 * `all`, default `all`), `EXDB_EVAL_TASKS` (comma-separated ids). Runs
 * alternate the modern and the legacy era. A safety task passes only when
 * every run passes; a capability task reports its rate. Transcripts:
 * `apps/server/test-results/evals/model-*.jsonl` and a summary `.md`.
 *
 * Without the key every task fails as NOT RUN: a missing model run is never
 * reported green. The key is read from that variable only, never from a
 * file or another variable found on the machine.
 */
const KEY = process.env['EXDB_EVAL_ANTHROPIC_API_KEY']
const MODEL = process.env['EXDB_EVAL_MODEL'] ?? 'claude-haiku-5-5'
const RUNS = Math.max(1, Math.min(20, Number(process.env['EXDB_EVAL_RUNS'] ?? 3) || 3))
const SPLIT = process.env['EXDB_EVAL_SPLIT'] ?? 'all'
const ONLY = process.env['EXDB_EVAL_TASKS']?.split(',').map((t) => t.trim())
const OUT = new URL('../test-results/evals/', import.meta.url)
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')

const tasks = EVAL_TASKS.filter(
  (t) =>
    (ONLY === undefined || ONLY.includes(t.id)) &&
    (SPLIT === 'all' || (SPLIT === 'holdout') === EVAL_HOLDOUT.has(t.id)),
)

let w: McpWorld | undefined
let clientId = ''
const results: { task: string; safety: boolean; runs: GradedRun[] }[] = []

beforeAll(async () => {
  if (KEY === undefined || KEY === '') return
  w = await mcpWorld('exdb_it_mcp_model_evals')
  clientId = await w.mcpClient('Eval Model')
}, 300_000)

afterAll(async () => {
  if (results.length > 0) {
    await mkdir(OUT, { recursive: true })
    await writeFile(
      new URL(`model-${STAMP}.jsonl`, OUT),
      results.flatMap((r) => r.runs.map(transcriptLine)).join('\n'),
    )
    const lines = results.map((r) => {
      const s = score(r.runs, r.safety)
      const failed = r.runs
        .flatMap((run) => run.verdicts.filter((v) => v.verdict.outcome === 'fail'))
        .map((v) => `${v.check} (${verdictText(v.verdict)})`)
      return `| ${r.task} | ${r.safety ? 'safety' : 'capability'} | ${EVAL_HOLDOUT.has(r.task) ? 'holdout' : 'tuning'} | ${Math.round(s.rate * 100)}% of ${r.runs.length} | ${s.passed ? 'pass' : 'FAIL'} | ${[...new Set(failed)].join('; ')} |`
    })
    await writeFile(
      new URL(`model-${STAMP}.md`, OUT),
      [
        `Model evals with ${MODEL}, ${RUNS} run(s) per task, split ${SPLIT}, ${new Date().toISOString()}.`,
        '',
        '| task | kind | split | runs passed | result | failed checks |',
        '|---|---|---|---|---|---|',
        ...lines,
        '',
      ].join('\n'),
    )
  }
  await w?.stop()
})

describe(`model evals (${MODEL})`, () => {
  for (const task of tasks) {
    it(`${task.id}: ${task.title}`, async () => {
      if (KEY === undefined || KEY === '' || w === undefined) {
        throw new Error(
          'NOT RUN: set EXDB_EVAL_ANTHROPIC_API_KEY to your own key to run the model evals',
        )
      }
      await task.setup?.(w)
      const runs: GradedRun[] = []
      for (let i = 1; i <= RUNS; i += 1) {
        const agent = messagesApiAgent({ apiKey: KEY, model: MODEL })
        runs.push(await runTask(w, clientId, task, agent, i, i % 2 === 1 ? 'modern' : 'legacy'))
      }
      results.push({ task: task.id, safety: task.safety, runs })
      const s = score(runs, task.safety)
      expect(
        s.passed,
        `${task.id}: ${runs.filter((r) => r.passed).length} of ${runs.length} runs passed`,
      ).toBe(true)
    })
  }
})
