#!/usr/bin/env bash
# S7 task 2d/2e, second part: I3b sequential TOCTOU (two plans of one id with different bytes, then apply one after the other),
# I4h the dangling bundle stored through the REST ingest endpoint (no planning), then planning for the project. Disposable lab only.
set -u
source /srv/work/s7/env.sh
L7=${L7:-/srv/work/logs-s7}; PROJ=$(stack_id project); A=http://127.0.0.1:58480/api/v1
refresh() { exdb whoami >/dev/null 2>&1; TOK=$(jq -r '.credentials | to_entries[0].value.accessToken' "${EXSTACK_STATE}/cli/credentials.json"); }
rest() { local m=$1 p=$2 b=${3:-}; refresh; curl -s -m 120 -X "$m" -H "Authorization: Bearer $TOK" -H 'content-type: application/json' ${b:+--data-binary @"$b"} -w '\n%{http_code}' "$A$p" > "$L7/rest2.raw"; tail -1 "$L7/rest2.raw" > "$L7/rest2.status"; head -n -1 "$L7/rest2.raw" > "$L7/rest2.last"; echo "$(cat "$L7/rest2.status") $(jq -r '.code // (.items|map(.status)|join(",")) // empty' "$L7/rest2.last" 2>/dev/null)"; }
body() { python3 - "$1" "$2" <<'PY'
import json,os,sys
d=sys.argv[1]; name=os.path.basename(d); files={}
for f in ('migration.yaml','up.sql','verify.sql','down.sql'):
    p=os.path.join(d,f)
    if os.path.exists(p): files[f]=open(p).read()
json.dump({'bundles':[{'directory':name,'files':files}],'defaults':{'lockTimeout':'5s','statementTimeout':'15m','role':'owner','searchPath':['public']}},open(sys.argv[2],'w'))
PY
}
indep() { sed -i '/^dependsOn:/,/^execution:/{/^  - /d;s/^dependsOn:$/dependsOn: []/}' "$1"/migration.yaml; }
echo "== I3b sequential: plan variant A for t1 and variant B for t2 (both before any apply), then apply A, then apply B"
PA=$(new_project s7imm4a); PB=$(new_project s7imm4b)
ID=$(mkb "$PA" s7-imm-w <<<"CREATE TABLE public.s7_imm_w_a(id int primary key); GRANT SELECT ON public.s7_imm_w_a TO lab_owner;"); DA=$(ls -d $PA/migrations/${ID}_*); indep "$DA"
DB="$PB/migrations/$(basename "$DA")"; mkdir -p "$DB"; cp "$DA"/migration.yaml "$DA"/verify.sql "$DB"/
printf 'CREATE TABLE public.s7_imm_w_b(id int primary key); GRANT SELECT ON public.s7_imm_w_b TO lab_owner;\n' > "$DB/up.sql"
add_target s7imm4t1 pg17 >/dev/null; add_target s7imm4t2 pg17 >/dev/null
mplan "$PA" lab/platform/s7imm4t1 "$ID"; PL1=$PLAN_ID; mplan "$PB" lab/platform/s7imm4t2 "$ID"; PL2=$PLAN_ID
mapply "$PL1" | cut -c1-170; mapply "$PL2" | cut -c1-170
echo "   ledger t1: $(ledger pg17 lab_s7imm4t1 | cut -c1-80)"; echo "   ledger t2: $(ledger pg17 lab_s7imm4t2 | cut -c1-80)"
echo "   plan lifetime: $(exdb_json plan show "$PL2" 2>/dev/null | jq -r '.data.expiresAt // .expiresAt // "?"')"

echo "== I4h dangling bundle stored through the ingest endpoint (REST), no planning"
P4=$(new_project s7dang3)
OK1=$(mkb "$P4" s7-dang3-ok <<<"CREATE TABLE public.s7_dang3_ok(id int primary key); GRANT SELECT ON public.s7_dang3_ok TO lab_owner;"); indep "$(ls -d $P4/migrations/${OK1}_*)"
BAD=$(mkb "$P4" s7-dang3-bad <<<"CREATE TABLE public.s7_dang3_bad(id int primary key); GRANT SELECT ON public.s7_dang3_bad TO lab_owner;")
BADDIR=$(ls -d $P4/migrations/${BAD}_*); sed -i '/^dependsOn:/,/^execution:/{/^  - /d;s/^dependsOn:$/dependsOn:\n  - 01ZZZZZZZZZZZZZZZZZZZZZZZY/}' "$BADDIR/migration.yaml"
body "$BADDIR" "$L7/dang-body.json"
echo "   ingest of the bundle whose dependsOn is unknown: $(rest POST /projects/$PROJ/bundles $L7/dang-body.json)"
echo "   stored revisions: $(ctl_sql "select count(*) from migrations.bundle_revisions where migration_id='$BAD'")"
mv "$BADDIR" "$P4/../s7dang3-removed"
add_target s7dang3t1 pg17 >/dev/null
echo "   migration status: pending entries naming it: $(exdb_json migration status --target lab/platform/s7dang3t1 | jq -r --arg b $BAD '[.data.pending[]?|select(.migrationId==$b)]|length'); pending in total: $(exdb_json migration status --target lab/platform/s7dang3t1 | jq -r '.data.pending|length')"
echo "   default plan of the remaining local bundle: $(cd "$P4" && exdb_json migration plan --target lab/platform/s7dang3t1 | jq -r '[.error.code // "plan", .data.decision // "", (.error.details|tostring|.[0:90])]|join(" ")')"
echo "   plan by the stored dangling id: $(cd "$P4" && exdb_json migration plan --target lab/platform/s7dang3t1 "$BAD" | jq -r '[.error.code // "plan", .data.decision // "", (.error.details|tostring|.[0:90])]|join(" ")')"
echo "   the same default plan from a SECOND project directory that has no local bundle at all: $(P6=$(new_project s7dang3b); cd "$P6" && exdb_json migration plan --target lab/platform/s7dang3t1 | jq -r '[.error.code // "plan", .error.message[0:100]]|join(" ")')"
echo "   bundle store listing for the project (REST, count of stored ids): $(rest GET "/projects/$PROJ/bundles" ) $(jq -r '.items|length? // "n/a"' $L7/rest2.last)"
