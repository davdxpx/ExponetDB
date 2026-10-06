import { describe, expect, it } from 'vitest'
import { decodeQuery, ROUTES, type RouteContract } from '../src/index.ts'

const routes: readonly RouteContract[] = ROUTES

function queryOf(operationId: string) {
  const route = routes.find((r) => r.operationId === operationId)
  if (route?.query === undefined) {
    throw new Error(`${operationId} has no query`)
  }
  return route.query
}

describe('query decoding (REST, form style)', () => {
  it('decodes declared integers and booleans, so a page size reaches the schema as a number', () => {
    const query = queryOf('listOAuthClients')
    const decoded = decodeQuery(query, { limit: '200', state: 'pending' })
    expect(decoded).toEqual({ limit: 200, state: 'pending' })
    expect(query.safeParse(decoded).success).toBe(true)
  })

  it('keeps everything else as text for the schema to refuse', () => {
    const query = queryOf('listOAuthClients')
    for (const limit of ['', '0x10', '1e2', '20.5', ' 20', '+20', '01', '9'.repeat(20)]) {
      const decoded = decodeQuery(query, { limit })
      expect(query.safeParse(decoded).success, limit).toBe(false)
    }
    expect(query.safeParse(decodeQuery(query, { limit: '201' })).success).toBe(false)
    expect(query.safeParse(decodeQuery(query, { other: '1' })).success).toBe(false)
  })

  it('decodes a boolean only from true or false', () => {
    const route = routes.find((r) => r.query !== undefined && 'includeResolved' in r.query.shape)
    if (route?.query === undefined) {
      throw new Error('no route with a boolean query parameter')
    }
    expect(decodeQuery(route.query, { includeResolved: 'true' })).toEqual({ includeResolved: true })
    expect(route.query.safeParse(decodeQuery(route.query, { includeResolved: '1' })).success).toBe(
      false,
    )
  })
})
