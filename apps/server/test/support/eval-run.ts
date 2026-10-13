import {
  createProtocolClient,
  type EvalAgent,
  type GradedRun,
  grade,
  ToolSession,
} from '@exponetdb/testkit/mcp'
import { type EvalTask, probe } from './eval-tasks.ts'
import type { McpWorld } from './mcp-int-world.ts'
import { ORIGIN } from './node-world.ts'

/** Runs one task once with one agent and grades it (the world's worker turns before an observation). */
export async function runTask(
  world: McpWorld,
  /** One registered client for every run (registration is rate-limited); a fresh token per run. */
  clientId: string,
  task: EvalTask,
  agent: EvalAgent,
  run: number,
  era: 'modern' | 'legacy' = 'modern',
): Promise<GradedRun> {
  const token = (await world.mcpToken(clientId, task.scopes, task.tiers)).access_token
  const before = await probe(world)
  const { client, close } = await createProtocolClient({
    era,
    token,
    url: `${ORIGIN}/mcp`,
    fetch: async (input, init) => world.app.request(String(input), init),
  })
  const hooks = task.hooks?.(world) ?? {}
  const session = new ToolSession(client, {
    before: async (name, args, n) => {
      if (['operation_get', 'operation_list', 'plan_get', 'migration_status'].includes(name)) {
        await world.drive()
      }
      await hooks.before?.(name, args, n)
    },
    ...(hooks.after === undefined ? {} : { after: hooks.after }),
  })
  let finalMessage = ''
  let error: string | undefined
  try {
    finalMessage = (await agent.run(task.prompt(world), session)).finalMessage
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  } finally {
    await close()
  }
  await world.drive()
  await world.settled()
  const after = await probe(world)
  return grade(
    task.id,
    agent.name,
    run,
    { calls: session.calls, finalMessage, before, after },
    task.checks(world),
    error,
  )
}
