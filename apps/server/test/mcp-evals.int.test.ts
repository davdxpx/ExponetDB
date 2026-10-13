import { mkdir, writeFile } from 'node:fs/promises'
import { type GradedRun, scriptedAgent, transcriptLine } from '@exponetdb/testkit/mcp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runTask } from './support/eval-run.ts'
import { EVAL_TASKS, verdictText } from './support/eval-tasks.ts'
import { type McpWorld, mcpWorld } from './support/mcp-int-world.ts'

/**
 * The eval harness without a model (Wave 7 order §29): every task runs with
 * its reference script, which must pass every check, and, where the task
 * has one, with an unsafe script, which the named check must reject. This
 * proves the graders (state first, then the calls, then the message)
 * before a model is ever graded by them. Model runs: `bun run mcp:evals`
 * with the owner's key (`apps/server/test/mcp-evals.model.ts`).
 */
const OUT = new URL('../test-results/evals/', import.meta.url)
let w: McpWorld
let clientId: string
const runs: GradedRun[] = []

beforeAll(async () => {
  w = await mcpWorld('exdb_it_mcp_evals')
  clientId = await w.mcpClient('Eval Agent')
}, 300_000)

afterAll(async () => {
  await mkdir(OUT, { recursive: true })
  await writeFile(new URL('reference.jsonl', OUT), runs.map(transcriptLine).join('\n'))
  await w?.stop()
})

describe('eval tasks: the graders accept a correct run and reject an unsafe one (no model)', () => {
  for (const task of EVAL_TASKS) {
    it(`${task.id}: ${task.title}`, async () => {
      await task.setup?.(w)
      const reference = task.reference(w)
      const good = await runTask(
        w,
        clientId,
        task,
        scriptedAgent('reference', reference.steps, reference.message),
        1,
      )
      runs.push(good)
      expect(
        good.verdicts
          .filter((v) => v.verdict.outcome !== 'pass')
          .map((v) => `${v.check}: ${verdictText(v.verdict)}`),
        `${task.id} reference: ${good.calls.map((c) => `${c.name}${c.code === undefined ? '' : `=${c.code}`}`).join(' ')}`,
      ).toEqual([])
      expect(good.passed).toBe(true)
      if (task.unsafe !== undefined) {
        const unsafe = task.unsafe(w)
        const bad = await runTask(
          w,
          clientId,
          task,
          scriptedAgent('unsafe', unsafe.steps, unsafe.message),
          2,
        )
        runs.push(bad)
        expect(bad.passed, `${task.id} unsafe run passed`).toBe(false)
        const rejected = bad.verdicts.find((v) => v.check === unsafe.rejectedBy)
        expect(rejected?.verdict.outcome, `${task.id}: ${unsafe.rejectedBy}`).toBe('fail')
      }
    }, 300_000)
  }
})
