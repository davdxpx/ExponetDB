import { ACTIONS } from '@exponetdb/contracts'
import { describe, expect, it } from 'vitest'
import {
  KIND_TITLES,
  migrationCountOf,
  serverIdOf,
  type TitleRefs,
  titleOf,
} from '../../src/features/plans/plan-title.ts'
import { en } from '../../src/lib/i18n/en.ts'

const NONE: TitleRefs = {
  targetPath: null,
  targetId: null,
  clusterId: null,
  nodeId: null,
  serverId: null,
}
const SERVER = 'srv_01M4S9000000000000000000AK'
const NODE = 'nod_01M4S9000000000000000000AN'
const CLUSTER = 'cls_01M4S9000000000000000000AF'

describe('the title of a plan', () => {
  it('has a sentence for every kind the contract plans and stores', () => {
    const planned = Object.entries(ACTIONS)
      .filter(([, action]) => action.mechanism === 'stored_plan')
      .map(([kind]) => kind)
    expect(planned.length).toBeGreaterThan(20)
    expect(planned.filter((kind) => !Object.hasOwn(KIND_TITLES, kind))).toEqual([])
    for (const entry of Object.values(KIND_TITLES)) {
      expect(Object.hasOwn(en, entry.key), entry.key).toBe(true)
      if (entry.byId !== undefined) expect(Object.hasOwn(en, entry.byId), entry.byId).toBe(true)
      // A sentence that names a subject has a place for it.
      expect(en[entry.key].includes('{subject}'), entry.key).toBe(entry.subject !== 'none')
    }
  })

  it('names a node enrollment by its server, by name once read and by id until then', () => {
    const refs = { ...NONE, serverId: SERVER }
    expect(titleOf('node.enroll', refs, { serverName: 'tour host' })).toEqual({
      key: 'plans.title.node.enroll',
      subject: { kind: 'name', text: 'tour host' },
    })
    expect(titleOf('node.enroll', refs, {})).toEqual({
      key: 'plans.title.node.enroll',
      subject: { kind: 'id', text: SERVER },
    })
    expect(titleOf('node.enroll', NONE, {})).toEqual({
      key: 'plans.title.node.enroll',
      subject: { kind: 'not_known' },
    })
  })

  it('names a node by its server once read, and by the sentence for a node id otherwise', () => {
    const refs = { ...NONE, nodeId: NODE }
    expect(titleOf('node.revoke', refs, { serverName: 'db-1' })).toEqual({
      key: 'plans.title.node.revoke',
      subject: { kind: 'name', text: 'db-1' },
    })
    expect(titleOf('node.revoke', refs, {})).toEqual({
      key: 'plans.title.node.revoke.byId',
      subject: { kind: 'id', text: NODE },
    })
  })

  it('counts the migrations of a migration plan and names its target by path', () => {
    const refs = { ...NONE, targetPath: 'shop/platform/production', targetId: 'tgt_x' }
    expect(titleOf('migration.apply', refs, {}, 1).key).toBe('plans.title.migration.apply.one')
    expect(titleOf('migration.apply', refs, {}, 3)).toEqual({
      key: 'plans.title.migration.apply.many',
      count: 3,
      subject: { kind: 'name', text: 'shop/platform/production' },
    })
    // A count that is not known, or none, is not said.
    expect(titleOf('migration.apply', refs, {}, null).key).toBe('plans.title.migration.apply')
    expect(titleOf('migration.apply', refs, {}, 0).key).toBe('plans.title.migration.apply')
    // Without a path, the target's id.
    expect(titleOf('target.suspend', { ...NONE, targetId: 'tgt_x' }, {}).subject).toEqual({
      kind: 'id',
      text: 'tgt_x',
    })
  })

  it('names a cluster by name once read, else by id; kinds without a subject name none', () => {
    const refs = { ...NONE, clusterId: CLUSTER }
    expect(titleOf('postgres.restart', refs, { clusterName: 'main' }).subject).toEqual({
      kind: 'name',
      text: 'main',
    })
    expect(titleOf('postgres.restart', refs, {}).subject).toEqual({ kind: 'id', text: CLUSTER })
    expect(titleOf('access.role_binding.create', refs, {})).toEqual({
      key: 'plans.title.access.role_binding.create',
    })
  })

  it('says "Run <kind>" for a kind this version does not know, never a prototype property', () => {
    expect(titleOf('future.kind', { ...NONE, targetPath: 'a/b/c' }, {})).toEqual({
      key: 'plans.title.other',
      kind: 'future.kind',
      subject: { kind: 'name', text: 'a/b/c' },
    })
    expect(titleOf('toString', NONE, {})).toEqual({
      key: 'plans.title.otherBare',
      kind: 'toString',
    })
    expect(titleOf('__proto__', { ...NONE, clusterId: CLUSTER }, {}).subject).toEqual({
      kind: 'id',
      text: CLUSTER,
    })
  })

  it('reads the server and the migration count from a change, and nothing else', () => {
    expect(serverIdOf({ serverId: SERVER, tokenId: 'ent_x' })).toBe(SERVER)
    expect(serverIdOf({ serverId: 'srv_../x' })).toBeNull()
    expect(serverIdOf([SERVER])).toBeNull()
    expect(serverIdOf(null)).toBeNull()
    expect(migrationCountOf({ migrations: [{}, {}] })).toBe(2)
    expect(migrationCountOf({ migrations: 'x' })).toBeNull()
    expect(migrationCountOf(undefined)).toBeNull()
  })
})
