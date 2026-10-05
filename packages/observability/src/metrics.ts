/**
 * Metrics registry ([self-observability.md §3](../../../exponetdb-docs/10-observability/self-observability.md#3-core-metrics)).
 *
 * Counters, gauges and histograms with declared label names, rendered as
 * Prometheus text (exposition format 0.0.4) on the internal listener. No
 * vendor client library.
 *
 * Labels are low-cardinality by construction: every label declares either a
 * closed set of values or a value pattern with a cap on distinct values.
 * A value outside the set, beyond the cap, or that looks like an entity id
 * (`tgt_…`, a bare ULID, a UUID) is recorded as `other`. Target ids, identity
 * ids, plan ids and operation ids never become label values.
 */
export type LabelSpec =
  | { readonly values: readonly string[] }
  | { readonly pattern: RegExp; readonly maxDistinct: number }

export type Labels<L extends string> = Readonly<Record<L, string>>

const NAME = /^exdb_[a-z][a-z0-9_]*$/
const LABEL = /^[a-z][a-z0-9_]*$/
const ID_LIKE =
  /(?:^|[^A-Za-z0-9])(?:[a-z]{2,3}_[0-7][0-9A-HJKMNP-TV-Z]{25}|[0-7][0-9A-HJKMNP-TV-Z]{25}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:$|[^A-Za-z0-9])/i
export const OTHER = 'other'

class LabelGuard<L extends string> {
  readonly #specs: Readonly<Record<L, LabelSpec>>
  readonly #seen = new Map<L, Set<string>>()
  readonly names: readonly L[]

  constructor(specs: Readonly<Record<L, LabelSpec>>) {
    this.#specs = specs
    const names: L[] = []
    for (const name in specs) {
      if (!LABEL.test(name)) {
        throw new Error(`invalid label name ${name}`)
      }
      names.push(name)
    }
    this.names = names.sort()
  }

  normalize(labels: Labels<L>): string[] {
    return this.names.map((name) => {
      const value = labels[name]
      const spec = this.#specs[name]
      if (typeof value !== 'string' || ID_LIKE.test(value)) {
        return OTHER
      }
      if ('values' in spec) {
        return spec.values.includes(value) ? value : OTHER
      }
      if (!spec.pattern.test(value)) {
        return OTHER
      }
      const seen = this.#seen.get(name) ?? new Set<string>()
      this.#seen.set(name, seen)
      if (!seen.has(value) && seen.size >= spec.maxDistinct) {
        return OTHER
      }
      seen.add(value)
      return value
    })
  }
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

function labelText(names: readonly string[], values: readonly string[], extra = ''): string {
  const parts = names.map((n, i) => `${n}="${escapeLabel(values[i] ?? '')}"`)
  if (extra.length > 0) {
    parts.push(extra)
  }
  return parts.length === 0 ? '' : `{${parts.join(',')}}`
}

function formatNumber(n: number): string {
  if (Number.isNaN(n)) {
    return 'NaN'
  }
  if (!Number.isFinite(n)) {
    return n > 0 ? '+Inf' : '-Inf'
  }
  return String(n)
}

interface Metric {
  readonly name: string
  render(): string[]
}

export class Counter<L extends string = never> implements Metric {
  readonly #guard: LabelGuard<L>
  readonly #values = new Map<string, { labels: string[]; value: number }>()
  readonly name: string
  readonly help: string
  constructor(name: string, help: string, labels: Readonly<Record<L, LabelSpec>>) {
    this.name = name
    this.help = help
    this.#guard = new LabelGuard(labels)
  }

  inc(labels: Labels<L>, by = 1): void {
    if (!(by >= 0) || !Number.isFinite(by)) {
      return
    }
    const values = this.#guard.normalize(labels)
    const key = values.join('\u0000')
    const entry = this.#values.get(key) ?? { labels: values, value: 0 }
    entry.value += by
    this.#values.set(key, entry)
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`]
    for (const { labels, value } of [...this.#values.values()].sort(byLabels)) {
      lines.push(`${this.name}${labelText(this.#guard.names, labels)} ${formatNumber(value)}`)
    }
    return lines
  }
}

export class Gauge<L extends string = never> implements Metric {
  readonly #guard: LabelGuard<L>
  readonly #values = new Map<string, { labels: string[]; value: number }>()
  readonly name: string
  readonly help: string
  constructor(name: string, help: string, labels: Readonly<Record<L, LabelSpec>>) {
    this.name = name
    this.help = help
    this.#guard = new LabelGuard(labels)
  }

  set(labels: Labels<L>, value: number): void {
    const values = this.#guard.normalize(labels)
    this.#values.set(values.join('\u0000'), { labels: values, value })
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`]
    for (const { labels, value } of [...this.#values.values()].sort(byLabels)) {
      lines.push(`${this.name}${labelText(this.#guard.names, labels)} ${formatNumber(value)}`)
    }
    return lines
  }
}

export const DEFAULT_SECONDS_BUCKETS: readonly number[] = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
]

export class Histogram<L extends string = never> implements Metric {
  readonly #guard: LabelGuard<L>
  readonly #buckets: readonly number[]
  readonly #values = new Map<
    string,
    { labels: string[]; counts: number[]; sum: number; count: number }
  >()
  readonly name: string
  readonly help: string
  constructor(
    name: string,
    help: string,
    labels: Readonly<Record<L, LabelSpec>>,
    buckets: readonly number[] = DEFAULT_SECONDS_BUCKETS,
  ) {
    this.name = name
    this.help = help
    this.#guard = new LabelGuard(labels)
    this.#buckets = [...buckets].sort((a, b) => a - b)
  }

  observe(labels: Labels<L>, value: number): void {
    if (!Number.isFinite(value)) {
      return
    }
    const values = this.#guard.normalize(labels)
    const key = values.join('\u0000')
    const entry = this.#values.get(key) ?? {
      labels: values,
      counts: this.#buckets.map(() => 0),
      sum: 0,
      count: 0,
    }
    this.#buckets.forEach((le, i) => {
      if (value <= le) {
        entry.counts[i] = (entry.counts[i] ?? 0) + 1
      }
    })
    entry.sum += value
    entry.count += 1
    this.#values.set(key, entry)
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`]
    const names = this.#guard.names
    for (const entry of [...this.#values.values()].sort(byLabels)) {
      this.#buckets.forEach((le, i) => {
        lines.push(
          `${this.name}_bucket${labelText(names, entry.labels, `le="${formatNumber(le)}"`)} ${entry.counts[i] ?? 0}`,
        )
      })
      lines.push(`${this.name}_bucket${labelText(names, entry.labels, 'le="+Inf"')} ${entry.count}`)
      lines.push(`${this.name}_sum${labelText(names, entry.labels)} ${formatNumber(entry.sum)}`)
      lines.push(`${this.name}_count${labelText(names, entry.labels)} ${entry.count}`)
    }
    return lines
  }
}

function byLabels(a: { labels: string[] }, b: { labels: string[] }): number {
  const x = a.labels.join('\u0000')
  const y = b.labels.join('\u0000')
  return x < y ? -1 : x > y ? 1 : 0
}

export class MetricsRegistry {
  readonly #metrics = new Map<string, Metric>()

  #add<M extends Metric>(metric: M): M {
    if (!NAME.test(metric.name)) {
      throw new Error(`metric names start with exdb_: ${metric.name}`)
    }
    if (this.#metrics.has(metric.name)) {
      throw new Error(`metric registered twice: ${metric.name}`)
    }
    this.#metrics.set(metric.name, metric)
    return metric
  }

  counter<L extends string = never>(
    name: string,
    help: string,
    labels: Readonly<Record<L, LabelSpec>>,
  ): Counter<L> {
    return this.#add(new Counter(name, help, labels))
  }

  gauge<L extends string = never>(
    name: string,
    help: string,
    labels: Readonly<Record<L, LabelSpec>>,
  ): Gauge<L> {
    return this.#add(new Gauge(name, help, labels))
  }

  histogram<L extends string = never>(
    name: string,
    help: string,
    labels: Readonly<Record<L, LabelSpec>>,
    buckets?: readonly number[],
  ): Histogram<L> {
    return this.#add(new Histogram(name, help, labels, buckets))
  }

  /** Prometheus text exposition of every metric, sorted by name. */
  render(): string {
    const names = [...this.#metrics.keys()].sort()
    const lines: string[] = []
    for (const name of names) {
      lines.push(...(this.#metrics.get(name)?.render() ?? []))
    }
    return `${lines.join('\n')}\n`
  }
}

/** Label specs shared by several metrics. */
export const LABELS = {
  role: { values: ['serve', 'worker', 'gateway', 'migrate', 'cli'] },
  statusClass: { values: ['1xx', '2xx', '3xx', '4xx', '5xx'] },
  method: { values: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] },
  outcome: { values: ['ok', 'error', 'timeout'] },
  /** A static code identifier such as `audit.append`; never user input. */
  queryClass: { pattern: /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/, maxDistinct: 200 },
  route: { pattern: /^\/[a-z0-9_./{}-]{0,80}$/, maxDistinct: 100 },
} as const satisfies Record<string, LabelSpec>

export function statusClass(status: number): string {
  return `${Math.min(5, Math.max(1, Math.floor(status / 100)))}xx`
}
