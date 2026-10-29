source /srv/work/s4/env.sh; cd $S4/authz
refresh_creds
T=$(cat $S4/creds/owner.token); A=http://127.0.0.1:58480/api/v1
C17=$(stack_id cluster_pg17)
REPO=$(curl -s -H "Authorization: Bearer $T" $A/clusters/$C17/backup-repositories | jq -r '.items[0].id')
echo "repo=$([ "$REPO" != null ] && echo yes || echo no)"
IDN=$(curl -s -H "Authorization: Bearer $T" "$A/identities" | jq -r '[.items[]|select(.kind=="human")][1].id')
jq --arg repo "$REPO" --arg idn "$IDN" '. as $f | .foreign = ($f.ids + {repositoryId:$repo, identityId:$idn}) | .ids = {}' fixtures.json > fixtures-existence.json
bun run-matrix.ts --base http://127.0.0.1:58480 --creds $S4/creds --fixtures fixtures-existence.json --matrix authz-matrix.json --samples authz-samples.json --bodies bodies.json --only rest --out $L4/authz/run-existence 2>&1 | tail -1
python3 - <<'PY'
import json,collections
r=json.load(open('/srv/work/logs-s4/authz/run-existence.json'))
ex=[x for x in r['results'] if '#existence' in x['row']]
print('existence comparisons that differ:',len(ex))
g=collections.defaultdict(set)
for x in ex:
    g[(x['row'].split('#')[0],x['row'].split('#')[1],x['verdict'][:95])].add(x['cls'])
for k,v in sorted(g.items()): print(k[0],k[1],'|',','.join(sorted(v)),'|',k[2])
PY
