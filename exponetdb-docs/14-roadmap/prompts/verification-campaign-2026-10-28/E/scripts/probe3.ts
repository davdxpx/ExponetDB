import { createHash } from 'node:crypto'
import { ledgerStateHash } from '<TREE>/packages/migrations/src/format/ledger-state.ts'
const r: any = ledgerStateHash([], null)
const want = 'sha256:ls1:' + createHash('sha256').update('baseline -\n').digest('hex')
console.log('empty ledger ls1 =', r.ok ? r.value.hash ?? JSON.stringify(r.value) : JSON.stringify(r))
console.log('sha256("baseline -\\n")     =', want)
const r2: any = ledgerStateHash([{ migrationId: '01M61ZX2TY7FFAKX4GQPJE0E68', checksum: 'sha256:c1:' + 'a'.repeat(64), reverted: false }, { migrationId: '01M61ZXSFE83V0SA9C2TBMP6FQ', checksum: 'sha256:c1:' + 'b'.repeat(64), reverted: true }], 'baseline:x-y')
const lines = '01M61ZX2TY7FFAKX4GQPJE0E68 sha256:c1:' + 'a'.repeat(64) + ' A\n' + '01M61ZXSFE83V0SA9C2TBMP6FQ sha256:c1:' + 'b'.repeat(64) + ' R\n' + 'baseline baseline:x-y\n'
console.log('two rows + baseline matches doc construction:', (r2.ok ? (r2.value.hash ?? '') : '') === 'sha256:ls1:' + createHash('sha256').update(lines).digest('hex'))
