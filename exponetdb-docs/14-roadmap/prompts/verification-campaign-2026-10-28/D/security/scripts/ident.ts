/**
 * S4: identities and credentials on the disposable stack (never prints a secret: ids and counts only).
 * Run from the stack kit directory (needs @exponetdb/* workspace resolution):
 *   cd $EXSTACK_KIT && EXSTACK_OWNER_FILE=... EXSTACK_PUBLIC_URL=... bun --conditions=@exponetdb/source s4/ident.ts <cmd> ...
 *
 *   invite <name> <addr>                   invites a person; the one-time link goes to $S4/humans/<name>.link (0600)
 *   bind <identityId> <roleId> <kind> [id]  plans + applies a role binding (kind: global|environment|project|target)
 *   sa <displayName>                       creates a service account (responsible: the owner); prints the id
 *   apikey <saId> <label> <tier,tier> [targetId,...]   creates an API key; the secret goes to $S4/creds/<label>.token (0600)
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { isScopeGrantableTo, SCOPE_IDS } from '@exponetdb/contracts'
import { Human, must } from '../human.ts'

const S4 = process.env['S4'] ?? '/srv/work/s4'
mkdirSync(`${S4}/humans`, { recursive: true, mode: 0o700 })
mkdirSync(`${S4}/creds`, { recursive: true, mode: 0o700 })

async function main(): Promise<void> {
  const [cmd, ...a] = process.argv.slice(2)
  const h = Human.load()
  await h.signIn()
  if (cmd === 'invite') {
    const [name, addr] = a
    await h.reauth()
    const r = await h.call('POST', '/api/v1/identities', { email: addr, displayName: `S4 ${name}` })
    must(r, 201, 'invite')
    writeFileSync(`${S4}/humans/${name}.link`, `${r.body.invitation.link}\n`, { mode: 0o600 })
    console.log(JSON.stringify({ invited: name, identityId: r.body.identity.id, delivery: r.body.invitation.delivery }))
  } else if (cmd === 'bind') {
    const [identityId, roleId, kind, id] = a
    const scope =
      kind === 'global' ? { kind: 'global' } : { kind, [`${kind}Id`]: id }
    const planned = await h.call('POST', '/api/v1/role-bindings', { identityId, roleId, scope })
    must(planned, 201, 'plan binding')
    await h.reauth()
    const applied = await h.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
    must(applied, 202, 'apply binding')
    if (applied.body.state === 'awaiting_approval') must(await h.approve(applied.body.id, planned.body.planHash), 200, 'approve binding')
    const op = await h.finished(applied.body.id)
    console.log(JSON.stringify({ bound: roleId, scope: kind, operation: op.state }))
  } else if (cmd === 'sa') {
    const [displayName] = a
    await h.reauth()
    const r = await h.call('POST', '/api/v1/service-accounts', { displayName, responsibleIdentityId: h.owner.identityId })
    must(r, 201, 'service account')
    console.log(JSON.stringify({ serviceAccount: r.body.identityId ?? r.body.id ?? r.body.identity?.id }))
  } else if (cmd === 'apikey') {
    const [saId, label, tiers, targets] = a
    const scopes = SCOPE_IDS.filter((s) => isScopeGrantableTo(s, 'ci'))
    await h.reauth()
    const body = {
      scopes,
      restrictions: {
        tiers: String(tiers).split(','),
        targets: targets === undefined || targets === '' ? { kind: 'all' } : { kind: 'list', targetIds: targets.split(',') },
      },
      label,
      lifetimeDays: 30,
      ...(String(tiers).includes('prod') ? { acknowledgeProductionWrite: true } : {}),
    }
    const r = await h.call('POST', `/api/v1/service-accounts/${saId}/api-keys`, body)
    must(r, 201, 'api key')
    writeFileSync(`${S4}/creds/${label}.token`, `${r.body.secret}\n`, { mode: 0o600 })
    chmodSync(`${S4}/creds/${label}.token`, 0o600)
    console.log(JSON.stringify({ apiKey: r.body.apiKey?.id, scopes: scopes.length, written: `${label}.token` }))
  } else throw new Error('invite | bind | sa | apikey')
}

main().catch((e: unknown) => {
  console.error(String(e instanceof Error ? e.message : e))
  process.exit(1)
})
