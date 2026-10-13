import {
  FilterBar,
  type FilterGroup,
  type FilterProperty,
  type FilterSuggestion,
} from '@exponetdb/ui-patterns'
import { useState } from 'react'
import type { DemoDefinition } from '../types.ts'

const EMPTY: FilterGroup = { logicalOperator: 'AND', conditions: [] }

const PROPERTIES: FilterProperty[] = [
  { label: 'Name', name: 'name', type: 'string', operators: ['=', '!=', 'CONTAINS'] },
  {
    label: 'Tier',
    name: 'tier',
    type: 'string',
    options: ['prod', 'nonprod'],
    operators: ['=', '!='],
  },
  {
    label: 'Health',
    name: 'health',
    type: 'string',
    options: ['healthy', 'degraded', 'unhealthy', 'unknown', 'stale'],
    operators: ['=', '!='],
  },
  { label: 'Cluster', name: 'cluster', type: 'string', operators: ['=', '!='] },
]

const CLUSTERS = ['pg-main', 'pg-reporting', 'pg-eu-west']

/** Suggestions the page loads: they arrive after a short delay, as a request would. */
function loadClusters(search?: string): Promise<FilterSuggestion[]> {
  return new Promise((resolve) => {
    setTimeout(() => {
      const needle = (search ?? '').toLowerCase()
      resolve(CLUSTERS.filter((name) => name.includes(needle)))
    }, 250)
  })
}

/** A loader that fails: the bar says so and never shows an empty list. */
function failingLoader(): Promise<FilterSuggestion[]> {
  return Promise.reject(new Error('The cluster list could not be read.'))
}

/** A controlled bar, the way a page uses it, with the structured value it produces. */
function ControlledBar({
  initial = EMPTY,
  properties = PROPERTIES,
  supportsOperators = false,
  freeformDefaultProperty,
}: {
  initial?: FilterGroup
  properties?: FilterProperty[]
  supportsOperators?: boolean
  freeformDefaultProperty?: string
}) {
  const [filters, setFilters] = useState(initial)
  const [freeformText, setFreeformText] = useState('')
  return (
    <div className="flex max-w-3xl flex-col gap-3">
      <FilterBar
        label="Filter targets"
        filterProperties={properties}
        filters={filters}
        onFilterChange={setFilters}
        freeformText={freeformText}
        onFreeformTextChange={setFreeformText}
        supportsOperators={supportsOperators}
        freeformDefaultProperty={freeformDefaultProperty}
      />
      <p className="text-xs text-foreground-lighter">
        The page receives structured conditions:{' '}
        <code className="font-mono text-foreground-light">
          {filters.conditions.length === 0
            ? 'none'
            : JSON.stringify(
                filters.conditions.map((condition) =>
                  'propertyName' in condition
                    ? `${condition.propertyName} ${condition.operator} ${String(condition.value)}`
                    : 'group',
                ),
              )}
        </code>
      </p>
    </div>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui-patterns/filter-bar/empty',
    title: 'Filter bar with no filter: a search field that lists the properties',
    render: () => <ControlledBar freeformDefaultProperty="name" />,
  },
  {
    id: 'ui-patterns/filter-bar/with-conditions',
    title: 'Filter bar with two conditions: each is a chip with its own remove button',
    render: () => (
      <ControlledBar
        initial={{
          logicalOperator: 'AND',
          conditions: [
            { propertyName: 'tier', operator: '=', value: 'prod' },
            { propertyName: 'health', operator: '=', value: 'degraded' },
          ],
        }}
      />
    ),
  },
  {
    id: 'ui-patterns/filter-bar/operators',
    title: 'Filter bar with operators: the operator of each condition can be changed',
    render: () => (
      <ControlledBar
        supportsOperators
        initial={{
          logicalOperator: 'AND',
          conditions: [{ propertyName: 'name', operator: 'CONTAINS', value: 'shop' }],
        }}
      />
    ),
  },
  {
    id: 'ui-patterns/filter-bar/loaded-suggestions',
    title: 'Suggestions the page loads, and one loader that fails: "Could not load suggestions"',
    visual: false,
    render: () => (
      <ControlledBar
        properties={[
          ...PROPERTIES.filter((property) => property.name !== 'cluster'),
          {
            label: 'Cluster',
            name: 'cluster',
            type: 'string',
            options: loadClusters,
            operators: ['=', '!='],
          },
          {
            label: 'Node',
            name: 'node',
            type: 'string',
            options: failingLoader,
            operators: ['=', '!='],
          },
        ]}
      />
    ),
  },
]
