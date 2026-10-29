#!/usr/bin/env bash
# I11 portability: with the Control Store (and every role) STOPPED, what works from a Git checkout with the CLI, and is the
# ledger in the target readable with psql only (C-35)?
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/i11.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
exdbo() { ( cd "$1"; shift; EXPONETDB_CONFIG_DIR="${EXSTACK_STATE}/cli" timeout 120 ${EXSTACK_NODE_BIN} --liftoff-only "${EXSTACK_CLI_BIN}" "$@" 2>&1 ); }
echo "== which commands are local (no server) according to the CLI itself"
exdb commands | awk '$2=="local"{print $1" "$2" "$3}' | tr '\n' ';'; echo
echo "== a project with two bundles from a clean 'git checkout' (no state dir, no sign-in): copy only the files"
GIT=$(mktemp -d /dev/shm/s6git.XXXX)
cp -r /srv/work/s6/projects/s6p/exponetdb.project.yaml $GIT/; mkdir $GIT/migrations
( cd $GIT; git init -q . 2>/dev/null )
P=$(new_project s6i11); 
echo 'CREATE TABLE public.i11_a (id int primary key);' | mkb $P i11-a >/dev/null
echo 'CREATE TABLE public.i11_b (id int primary key, a int references public.i11_a(id));' | mkb $P i11-b >/dev/null
cp -r $P/migrations/* $GIT/migrations/; cp $P/exponetdb.project.yaml $GIT/
echo "== STOP everything: roles and Control Store"
for r in serve worker gateway; do systemctl stop $(_stk_unit $r); done; docker stop $EXSTACK_CONTROL_NAME >/dev/null
echo "control store: $(docker inspect -f '{{.State.Status}}' $EXSTACK_CONTROL_NAME); serve: $(hc $S)"
echo "== offline CLI commands, config dir EMPTY (a CI runner / a laptop with only the checkout)"
EMPTY=$(mktemp -d /dev/shm/s6cfg.XXXX)
run() { local t0=$(date +%s.%N); local out; out=$(cd $GIT; EXPONETDB_CONFIG_DIR=$EMPTY timeout 60 ${EXSTACK_NODE_BIN} --liftoff-only "${EXSTACK_CLI_BIN}" "$@" 2>&1); local rc=$?; printf '%-34s rc=%s %.1fs | %s\n' "$*" "$rc" "$(echo "$(date +%s.%N)-$t0" | bc)" "$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-230)"; }
run --version
run project validate
run migration lint
run migration lint --json
run migration checksum
run migration graph
run migration list
run migration plan --target lab/platform/staging
run migration plan --target lab/platform/staging --offline
run migration apply
run migration status --target lab/platform/staging
run migration verify
run target list
run doctor
run whoami
echo "== the same with the CLI signed in (profile + tokens) but the server down"
run2() { local out; out=$(cd $GIT; EXPONETDB_CONFIG_DIR=${EXSTACK_STATE}/cli timeout 60 ${EXSTACK_NODE_BIN} --liftoff-only "${EXSTACK_CLI_BIN}" "$@" 2>&1); printf '%-34s rc=%s | %s\n' "$*" "$?" "$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-230)"; }
run2 migration lint; run2 migration plan --target lab/platform/staging; run2 target list; run2 whoami
echo "== checksum of the same bundle: offline vs the server-side value (after restart)"
CK_OFF=$(cd $GIT; EXPONETDB_CONFIG_DIR=$EMPTY ${EXSTACK_NODE_BIN} --liftoff-only "${EXSTACK_CLI_BIN}" migration checksum --json 2>/dev/null | jq -c '[.. | objects | select(has("checksum")) | .checksum] | .[0:2]')
echo "offline checksums: $CK_OFF"
echo
echo "== ledger in the target with psql only (Control Store down, ExponetDB roles down): lab_staging on pg17"
export PGDATABASE=lab_staging
psql_target pg17 -c '\dn+ exponetdb' 2>&1 | head -8
psql_target pg17 -c '\dt+ exponetdb.*' 2>&1 | head -12
psql_target pg17 -c '\d exponetdb.schema_migrations' 2>&1 | head -40
psql_target pg17 -c 'select * from exponetdb.schema_migrations order by applied_seq' -x 2>&1 | head -40
for t in $(psql_target pg17 -Atc "select tablename from pg_tables where schemaname='exponetdb'" 2>/dev/null); do echo "-- exponetdb.$t: $(psql_target pg17 -Atc "select count(*) from exponetdb.$t") rows; columns: $(psql_target pg17 -Atc "select string_agg(column_name,',' order by ordinal_position) from information_schema.columns where table_schema='exponetdb' and table_name='$t'")"; done
psql_target pg17 -c '\df exponetdb.*' 2>&1 | head -12
echo "-- comments on the ledger objects:"; psql_target pg17 -Atc "select obj_description('exponetdb.schema_migrations'::regclass)" 2>&1 | head -3
rm -rf $GIT $EMPTY
echo "== start everything again"
docker start $EXSTACK_CONTROL_NAME >/dev/null; _stk_wait_control; restart_cp
echo "serve=$(hc $S)"
