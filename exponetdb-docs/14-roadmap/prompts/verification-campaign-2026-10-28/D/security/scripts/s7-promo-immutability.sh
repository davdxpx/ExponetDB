#!/usr/bin/env bash
# S7 task 2d/2e: immutability of stored bundles across the CLI and REST, concurrent ingestion of one id with different bytes,
# applying two byte-variants of one id on two targets at the same moment, and the dangling stored bundle (TC-008). Disposable lab only.
# usage on the server: ./s7-promo-immutability.sh
set -u
source /srv/work/s7/env.sh
L7=${L7:-/srv/work/logs-s7}
PROJ=$(stack_id project); A=http://127.0.0.1:58480/api/v1
refresh() { exdb whoami >/dev/null 2>&1; TOK=$(jq -r '.credentials | to_entries[0].value.accessToken' "${EXSTACK_STATE}/cli/credentials.json"); }
rest() { # METHOD path [body-file]  -> prints "<status> <code>" and keeps the body in $L7/rest.last
  local m=$1 p=$2 b=${3:-}; refresh
  curl -s -m 120 -X "$m" -H "Authorization: Bearer $TOK" -H 'content-type: application/json' ${b:+--data-binary @"$b"} -w '\n%{http_code}' "$A$p" > "$L7/rest.raw"
  tail -1 "$L7/rest.raw" > "$L7/rest.status"; head -n -1 "$L7/rest.raw" > "$L7/rest.last"; echo "$(cat "$L7/rest.status") $(jq -r '.code // (.items|map(.status)|join(",")) // empty' "$L7/rest.last" 2>/dev/null)"; }
# a bundle directory as the ingest body needs it
body() { # dir out-file
  python3 - "$1" "$2" <<'PY'
import json,os,sys
d=sys.argv[1]; name=os.path.basename(d); files={}
for f in ('migration.yaml','up.sql','verify.sql','down.sql'):
    p=os.path.join(d,f)
    if os.path.exists(p): files[f]=open(p).read()
json.dump({'bundles':[{'directory':name,'files':files}],'defaults':{'lockTimeout':'5s','statementTimeout':'15m','role':'owner','searchPath':['public']}},open(sys.argv[2],'w'))
PY
}
indep() { sed -i '/^dependsOn:/,/^execution:/{/^  - /d;s/^dependsOn:$/dependsOn: []/}' "$1"/migration.yaml; }
mkvariant() { # projdir slug sql -> dir of the bundle; prints the dir
  local P=$1 slug=$2 sql=$3 id; id=$(mkb "$P" "$slug" <<<"$sql"); local d; d=$(ls -d "$P"/migrations/${id}_*); indep "$d"; echo "$d"; }
revs() { ctl_sql "select revision||':'||left(checksum,22)||':'||ingested_by from migrations.bundle_revisions where migration_id='$1' order by revision" | tr '\n' ' '; }
T1=lab/platform/dev16; T2=lab/platform/dev18

echo "== I1 applied content cannot change (CLI, REST): bytes A applied on $T1, then bytes B for the same id"
PA=$(new_project s7immA); PB=$(new_project s7immB)
DA=$(mkvariant "$PA" s7-imm-x "CREATE TABLE public.s7_imm_x_a(id int primary key); GRANT SELECT ON public.s7_imm_x_a TO lab_owner;")
ID=$(basename "$DA" | cut -d_ -f1); SLUG=$(basename "$DA" | cut -d_ -f2-)
# bytes B: the same id and directory name, other executable text
DB="$PB/migrations/$(basename "$DA")"; mkdir -p "$DB"; cp "$DA"/migration.yaml "$DB"/; cp "$DA"/verify.sql "$DB"/ 2>/dev/null
printf 'CREATE TABLE public.s7_imm_x_b(id int primary key); GRANT SELECT ON public.s7_imm_x_b TO lab_owner;\n' > "$DB/up.sql"
( cd "$PA" && exdb_json migration checksum | jq -r '.data.items[0].checksum' ) > "$L7/imm-sumA"; ( cd "$PB" && exdb_json migration checksum | jq -r '.data.items[0].checksum' ) > "$L7/imm-sumB"
echo "   id=$ID checksum A=$(cut -c1-22 $L7/imm-sumA) B=$(cut -c1-22 $L7/imm-sumB)"
mplan "$PA" "$T1" "$ID"; mapply "$PLAN_ID" | cut -c1-160
body "$DB" "$L7/imm-bodyB.json"; body "$DA" "$L7/imm-bodyA.json"
echo "   REST ingest of bytes B after A was applied on $T1: $(rest POST /projects/$PROJ/bundles $L7/imm-bodyB.json)"
echo "   REST ingest of bytes A again (unchanged): $(rest POST /projects/$PROJ/bundles $L7/imm-bodyA.json)"
echo "   CLI plan of bytes B for another target $T2: $(cd "$PB" && exdb_json migration plan --target "$T2" "$ID" | jq -r '[.error.code // "plan", .error.details.knownChecksum[0:22]?]|join(" ")')"
echo "   CLI plan of bytes B for the SAME target $T1: $(cd "$PB" && exdb_json migration plan --target "$T1" "$ID" | jq -r '[.error.code // "plan", .error.details.knownChecksum[0:22]?]|join(" ")')"
echo "   stored revisions of $ID: $(revs $ID)"
echo "   MCP migration_plan takes inline bundles (contracts/src/mcp/tools.ts:492-514) and calls the same planMigrations -> ingestBundles; see the file for the MCP run"

echo "== I2 concurrent ingestion of one NEW id with different bytes: REST (A) and CLI plan (B) at the same moment, 3 rounds"
for round in 1 2 3; do
  PC=$(new_project s7imm2a$round); PD=$(new_project s7imm2b$round)
  DC=$(mkvariant "$PC" s7-imm-r "CREATE TABLE public.s7_imm_r${round}_a(id int primary key); GRANT SELECT ON public.s7_imm_r${round}_a TO lab_owner;")
  RID=$(basename "$DC" | cut -d_ -f1); DD="$PD/migrations/$(basename "$DC")"; mkdir -p "$DD"; cp "$DC"/migration.yaml "$DC"/verify.sql "$DD"/
  printf 'CREATE TABLE public.s7_imm_r%s_b(id int primary key); GRANT SELECT ON public.s7_imm_r%s_b TO lab_owner;\n' "$round" "$round" > "$DD/up.sql"
  body "$DC" "$L7/imm2-body-$round.json"; refresh
  ( curl -s -m 120 -X POST -H "Authorization: Bearer $TOK" -H 'content-type: application/json' --data-binary @"$L7/imm2-body-$round.json" -w '%{http_code}' "$A/projects/$PROJ/bundles" -o "$L7/imm2-rest-$round.json" > "$L7/imm2-rest-$round.status" ) &
  ( cd "$PD" && exdb_json migration plan --target "$T2" "$RID" > "$L7/imm2-cli-$round.json" ) &
  wait
  echo "   round $round: REST status=$(cat $L7/imm2-rest-$round.status) $(jq -c '[.items[]?.status, .code]|map(select(.!=null))' $L7/imm2-rest-$round.json) | CLI $(jq -r '[.data.state // .error.code, .data.decision // empty]|join(" ")' $L7/imm2-cli-$round.json) | revisions: $(revs $RID)"
done

echo "== I3 two byte-variants of one id planned for two targets, then applied at the same moment"
P3A=$(new_project s7imm3a); P3B=$(new_project s7imm3b)
D3A=$(mkvariant "$P3A" s7-imm-z "CREATE TABLE public.s7_imm_z_a(id int primary key); GRANT SELECT ON public.s7_imm_z_a TO lab_owner;")
ZID=$(basename "$D3A" | cut -d_ -f1); D3B="$P3B/migrations/$(basename "$D3A")"; mkdir -p "$D3B"; cp "$D3A"/migration.yaml "$D3A"/verify.sql "$D3B"/
printf 'CREATE TABLE public.s7_imm_z_b(id int primary key); GRANT SELECT ON public.s7_imm_z_b TO lab_owner;\n' > "$D3B/up.sql"
( cd "$P3A" && exdb_json migration plan --target lab/platform/s7imm3t1 "$ZID" >/dev/null ) 2>/dev/null
add_target s7imm3t1 pg17 >/dev/null; add_target s7imm3t2 pg17 >/dev/null
mplan "$P3A" lab/platform/s7imm3t1 "$ZID"; PA3=$PLAN_ID
mplan "$P3B" lab/platform/s7imm3t2 "$ZID"; PB3=$PLAN_ID
( exdb_json plan apply "$PA3" --wait > "$L7/imm3-applyA.json" 2>&1 ) & ( exdb_json plan apply "$PB3" --wait > "$L7/imm3-applyB.json" 2>&1 ) & wait
for v in A B; do echo "   apply $v: $(jq -r '[.error.code // "ok", (.data.state // "")]|join(" ")' "$L7/imm3-apply$v.json")"; done
echo "   ledger t1: $(ledger pg17 lab_s7imm3t1 | cut -c1-90)"; echo "   ledger t2: $(ledger pg17 lab_s7imm3t2 | cut -c1-90)"
echo "   stored revisions of $ZID: $(revs $ZID)"
echo "   next plan of variant A for t2 (history now differs between the targets): $(cd "$P3A" && exdb_json migration plan --target lab/platform/s7imm3t2 "$ZID" | jq -r '[.error.code // "plan", .data.decision // ""]|join(" ")')"

echo "== I4 the dangling stored bundle (TC-008): a bundle whose dependsOn names an id that exists nowhere"
P4=$(new_project s7dang)
OK1=$(mkb "$P4" s7-dang-ok <<<"CREATE TABLE public.s7_dang_ok(id int primary key); GRANT SELECT ON public.s7_dang_ok TO lab_owner;"); indep "$(ls -d $P4/migrations/${OK1}_*)"
BAD=$(mkb "$P4" s7-dang-bad <<<"CREATE TABLE public.s7_dang_bad(id int primary key); GRANT SELECT ON public.s7_dang_bad TO lab_owner;")
BADDIR=$(ls -d $P4/migrations/${BAD}_*); sed -i '/^dependsOn:/,/^execution:/{/^  - /d;s/^dependsOn:$/dependsOn:\n  - 01ZZZZZZZZZZZZZZZZZZZZZZZZ/}' "$BADDIR/migration.yaml"; grep -A2 '^dependsOn' "$BADDIR/migration.yaml" | head -3
add_target s7dangt1 pg17 >/dev/null
echo "   4a plan all local bundles for the target: $(cd "$P4" && exdb_json migration plan --target lab/platform/s7dangt1 | jq -r '[.error.code // "plan", (.error.details|tostring|.[0:80])]|join(" ")')"
echo "   4b stored revisions of the dangling bundle: $(revs $BAD)"
echo "   4c REST: is it listed as pending? $(exdb_json migration status --target lab/platform/s7dangt1 | jq -r --arg b $BAD '[.data.pending[]?|select(.migrationId==$b)|.migrationId]|length') entry(ies) in pending"
mv "$BADDIR" "$P4/../s7dang-removed-bad" 2>/dev/null
echo "   4d the dangling directory removed from the working tree; plan the rest (default): $(cd "$P4" && exdb_json migration plan --target lab/platform/s7dangt1 | jq -r '[.error.code // "plan", .data.decision // "", (.error.details|tostring|.[0:80])]|join(" ")')"
echo "   4e plan by explicit id $OK1: $(cd "$P4" && exdb_json migration plan --target lab/platform/s7dangt1 "$OK1" | jq -r '[.error.code // "plan", .data.decision // ""]|join(" ")')"
echo "   4f a second target of the same project, default plan: $(add_target s7dangt2 pg17 >/dev/null; cd "$P4" && exdb_json migration plan --target lab/platform/s7dangt2 | jq -r '[.error.code // "plan", .data.decision // ""]|join(" ")')"
echo "   4g a fresh project directory (no local bundle) asks for the pending set: $(P5=$(new_project s7dang2); cd "$P5" && exdb_json migration plan --target lab/platform/s7dangt1 | jq -r '[.error.code // "plan", .data.decision // "", (.error.details|tostring|.[0:80])]|join(" ")')"
