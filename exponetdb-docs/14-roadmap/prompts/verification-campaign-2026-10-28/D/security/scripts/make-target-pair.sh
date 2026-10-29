source /srv/work/s4/env.sh; cd $S4; refresh_creds
cp ${EXSTACK_KIT}/seed.ts ${EXSTACK_KIT}/s4/seed2.ts
sed -i "s#from './human.ts'#from '../human.ts'#; s#evidenceFrom: 'staging'#evidenceFrom: process.env['EVIDENCE_FROM'] ?? 'staging'#; s#\${tier === 'prod' ? { evidenceFrom: 'staging' } : {}}#\${tier === 'prod' ? { evidenceFrom: process.env['EVIDENCE_FROM'] ?? 'staging' } : {}}#" ${EXSTACK_KIT}/s4/seed2.ts
grep -n "EVIDENCE_FROM\|evidenceFrom" ${EXSTACK_KIT}/s4/seed2.ts | head
add2() { ( cd ${EXSTACK_KIT} && EVIDENCE_FROM=${3:-staging} EXSTACK_OWNER_FILE="${EXSTACK_STATE}/owner.json" EXSTACK_STATE="${EXSTACK_STATE}" EXSTACK_PG_PORT_BASE="${EXSTACK_PG_PORT_BASE}" bun --conditions=@exponetdb/source s4/seed2.ts add-target "$1" 17 "${2:-nonprod}" ) 2>&1 | tail -2; }
add2 s4evi nonprod
add2 s4prd prod s4evi
