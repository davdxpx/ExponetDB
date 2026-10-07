import { appendAuditEvent } from '@exponetdb/audit'
import type { ControlStore } from '@exponetdb/control-store'
import { type Clock, isId, type NodeId, type ServerId } from '@exponetdb/kernel'
import { b64u, bindProofMatches } from '@exponetdb/kernel/node'
import { type Keyring, readSecret } from '@exponetdb/secrets'
import { NodeError } from './errors.ts'

/**
 * Binding ([control-plane.md §6](../../../exponetdb-docs/07-node-agent/control-plane.md#6-worker),
 * ADR-0024 §2): the worker opens each pending node's token bind key and
 * checks the bind proof over the node's long-term keys. Only then is the node
 * active: a gateway that enrolled a node of its own making cannot produce the
 * proof, because it never held the bind key. A failed proof is final
 * (`binding_failed`); the bind key is never read again either way.
 */

/** The audit subject of a node, its ids checked. */
export function subjectOf(
  nodeId: string,
  serverId: string,
): { readonly nodeId: NodeId; readonly serverId: ServerId } {
  if (!isId('nod', nodeId) || !isId('srv', serverId)) {
    throw new NodeError('INTERNAL')
  }
  return { nodeId, serverId }
}

export interface BindingReport {
  readonly bound: number
  readonly failed: number
}

export async function bindPendingNodes(
  store: ControlStore,
  keyring: Keyring,
  clock: Clock,
  installationId: string,
): Promise<BindingReport> {
  const { rows } = await store.query(
    'nodes.binding.pending',
    `SELECT n.node_id FROM nodes.nodes n WHERE n.state = 'pending_binding' ORDER BY n.enrolled_at LIMIT 100`,
  )
  let bound = 0
  let failed = 0
  for (const pending of rows) {
    const nodeId = pending.text('node_id')
    const outcome = await store.transaction('nodes.binding.bind', async (tx) => {
      const found = await tx.query(
        'nodes.binding.node',
        `SELECT n.server_id, n.token_id, n.node_signing_key, n.node_encryption_key, n.bind_proof, t.bind_secret_id
           FROM nodes.nodes n JOIN nodes.enrollment_tokens t USING (token_id)
          WHERE n.node_id = $1 AND n.state = 'pending_binding'
          FOR UPDATE OF n`,
        [nodeId],
      )
      const node = found.rows[0]
      if (node === undefined) {
        return undefined
      }
      const secretId = node.textOrNull('bind_secret_id')
      const proof = node.textOrNull('bind_proof')
      let matches = false
      if (secretId !== null && proof !== null && isId('sec', secretId)) {
        const bindKey = await readSecret(tx, keyring, { secretId, consumer: 'worker' })
        try {
          matches = bindProofMatches(
            bindKey,
            {
              installationId,
              serverId: node.text('server_id'),
              tokenId: node.text('token_id'),
              nodeSigningKey: b64u(node.bytes('node_signing_key')),
              nodeEncryptionKey: b64u(node.bytes('node_encryption_key')),
            },
            proof,
          )
        } finally {
          bindKey.fill(0)
        }
      }
      await tx.query(
        'nodes.binding.set',
        `UPDATE nodes.nodes SET state = $2, state_reason = $3 WHERE node_id = $1`,
        [nodeId, matches ? 'active' : 'binding_failed', matches ? null : 'bind_proof_invalid'],
      )
      await appendAuditEvent(
        tx,
        {
          action: matches ? 'node.bound' : 'node.binding_failed',
          phase: 'completed',
          actor: { kind: 'system', identityId: null, label: 'system:worker' },
          subject: subjectOf(nodeId, node.text('server_id')),
          result: matches
            ? { status: 'succeeded' }
            : { status: 'failed', errorCode: 'NODE_PROOF_INVALID' },
        },
        { clock },
      )
      return matches
    })
    if (outcome === true) {
      bound++
    } else if (outcome === false) {
      failed++
    }
  }
  return { bound, failed }
}
