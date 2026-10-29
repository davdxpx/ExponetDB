source /srv/work/s4/env.sh; cd $S4/authz
which bun; bun --version
bun run-matrix.ts --self-test | tail -1
refresh_creds
mkdir -p $L4/authz
time bun run-matrix.ts --base http://127.0.0.1:58480 --creds $S4/creds --fixtures $S4/authz/fixtures.json --matrix $S4/authz/authz-matrix.json --samples $S4/authz/authz-samples.json --only rest --out $L4/authz/run-reads 2>&1 | tail -3
