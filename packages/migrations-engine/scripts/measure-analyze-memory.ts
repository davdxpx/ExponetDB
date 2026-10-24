/**
 * Measures the memory of a legacy import analysis (follow-up 2, F4): the
 * plan as serve makes it (the request's files, their digests, the parse of
 * every file for the replay summary, the rows written) and the replay as
 * the worker runs it, on a history of 600 files and 3 MB in the shape of a
 * Supabase-origin product. Prints the resident set size and its peak
 * (`VmHWM`) after each step, in MiB. Run it in a container with the memory
 * limit to check, against the test servers of the integration tests:
 *
 *   docker run --rm -m 512m --memory-swap 512m --network host … \
 *     node --conditions=@exponetdb/source packages/migrations-engine/scripts/measure-analyze-memory.ts
 */
import { largeWorld, peak, rss } from '../test/large-world.ts'

const mark = (step: string) =>
  process.stdout.write(
    `${step.padEnd(56)} rss ${String(rss()).padStart(5)} MiB   peak ${String(peak()).padStart(5)} MiB\n`,
  )

mark('start')
const w = await largeWorld()
mark('world ready (cluster, imported target, scratch target)')
try {
  const p = await w.plan()
  mark('analysis planned (as serve plans it)')
  const op = await w.apply(p)
  mark('replayed and classified (as the worker runs it)')
  const r = await w.report(p)
  const bytes = w.history.reduce((n, f) => n + Buffer.byteLength(f.text), 0)
  process.stdout.write(
    `${w.history.length} files, ${(bytes / 1e6).toFixed(2)} MB; plan ${p.decision}, operation ${op.state}, report ${r.state}\n`,
  )
} finally {
  await w.close()
}
