// Time / CPU / memory of a unit of work, appended as one JSON line (kept on disk, summarised in RESULTS.md).
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const FILE = process.env['B2_MEASURE_FILE'] ?? '/tmp/b2-run/measure.jsonl'

export interface Measured<T> {
  value: T
  ms: number
  cpuMs: number
  heapDeltaMb: number
  rssPeakMb: number
}

export function measure<T>(label: string, fn: () => T): Measured<T> {
  globalThis.gc?.()
  const h0 = process.memoryUsage().heapUsed
  const c0 = process.cpuUsage()
  const t0 = performance.now()
  const value = fn()
  const ms = performance.now() - t0
  const c = process.cpuUsage(c0)
  const mem = process.memoryUsage()
  const out = {
    value,
    ms: Math.round(ms * 10) / 10,
    cpuMs: Math.round((c.user + c.system) / 100) / 10,
    heapDeltaMb: Math.round(((mem.heapUsed - h0) / 1048576) * 10) / 10,
    rssPeakMb: Math.round((mem.rss / 1048576) * 10) / 10,
  }
  record(label, out)
  return out
}

export async function measureAsync<T>(label: string, fn: () => Promise<T>): Promise<Measured<T>> {
  globalThis.gc?.()
  const h0 = process.memoryUsage().heapUsed
  const c0 = process.cpuUsage()
  const t0 = performance.now()
  const value = await fn()
  const ms = performance.now() - t0
  const c = process.cpuUsage(c0)
  const mem = process.memoryUsage()
  const out = {
    value,
    ms: Math.round(ms * 10) / 10,
    cpuMs: Math.round((c.user + c.system) / 100) / 10,
    heapDeltaMb: Math.round(((mem.heapUsed - h0) / 1048576) * 10) / 10,
    rssPeakMb: Math.round((mem.rss / 1048576) * 10) / 10,
  }
  record(label, out)
  return out
}

function record(label: string, m: Omit<Measured<unknown>, 'value'>): void {
  try {
    mkdirSync(dirname(FILE), { recursive: true })
    appendFileSync(
      FILE,
      `${JSON.stringify({ label, ms: m.ms, cpuMs: m.cpuMs, heapDeltaMb: m.heapDeltaMb, rssMb: m.rssPeakMb, runtime: typeof Bun !== 'undefined' ? 'bun' : 'node', at: new Date().toISOString() })}\n`,
    )
  } catch {
    // measuring must never fail a test
  }
}

declare const Bun: unknown
