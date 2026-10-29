source /srv/work/s4/env.sh; cd $S4/authz
for cls in owner admin developer-nonprod developer-prod viewer service-account oauth-narrow; do
  refresh_creds
  rm -rf $S4/creds-one; mkdir -p $S4/creds-one; chmod 700 $S4/creds-one; cp $S4/creds/$cls.token $S4/creds-one/
  bun run-matrix.ts --base http://127.0.0.1:58480 --creds $S4/creds-one --fixtures fixtures-mut.json --matrix authz-matrix.json --samples authz-samples.json --bodies bodies.json --only rest --allow-mutations --out $L4/authz/run-mut-$cls 2>&1 | tail -1 | sed "s/^/$cls: /"
done
rm -rf $S4/creds-one
python3 - <<'PY'
import json,glob
res=[];notrun=[]
for f in sorted(glob.glob('/srv/work/logs-s4/authz/run-mut-*.json')):
    j=json.load(open(f)); res+=j['results']; notrun+=j['notRun']
json.dump({'results':res,'notRun':notrun},open('/srv/work/logs-s4/authz/run-mut.json','w'))
print(len(res))
PY
python3 /srv/work/s4/refine.py $L4/authz/run-mut.json | cut -c1-250
