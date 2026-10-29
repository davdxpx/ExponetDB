#!/usr/bin/env bash
# fail-closed steps 3 and 6: the Control Store data directory on a small loop-mounted filesystem, filled through the
# unaudited bundle ingest (C1-11). Reverts to the saved copy of the data directory at the end.
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/fc3.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
D=${EXSTACK_CONTROL_DATA}; C=$EXSTACK_CONTROL_NAME; IMG=/srv/work/s6/cs-small.img; MB=${MB:-420}
ING="node /srv/work/s6-infra/s6/ingest.mjs --api $API --headers $HDR --project $(jq -r .project ${EXSTACK_STATE}/ids.json)"
PGL() { docker logs --since "${1:-3m}" $C 2>&1 | grep -E "PANIC|FATAL|ERROR:|No space|could not" | sed 's/^[0-9-]* [0-9:.]* UTC //' | sort | uniq -c | sort -rn | head -${2:-8}; }
echo "data dir size: $(du -sm $D | cut -f1) MB; image $MB MB"
docker stop $C >/dev/null
mv $D $D.orig
dd if=/dev/zero of=$IMG bs=1M count=$MB status=none; mkfs.ext4 -q -m 0 $IMG; mkdir -p $D; mount -o loop $IMG $D
rsync -a $D.orig/ $D/
docker start $C >/dev/null; _stk_wait_control
for i in $(seq 1 60); do [ "$(hc $S)" = 200 ] && break; sleep 1; done
echo "stack ready on the small fs: serve=$(hc $S); df: $(df -m --output=size,used,avail $D | tail -1)"
bearer
echo "== step 6: unaudited ingest. audit head $(audit_head), bundle revisions $(ctl_sql 'select count(*) from migrations.bundle_revisions')"
$ING --per 50 --kb 600 --requests 1 --tag s6a
echo "after: audit head $(audit_head), revisions $(ctl_sql 'select count(*) from migrations.bundle_revisions'), table size $(ctl_sql "select pg_size_pretty(pg_total_relation_size('migrations.bundle_revisions'))")"
echo "audit events about it: $(ctl_sql "select count(*) from audit.audit_events where occurred_at > now() - interval '2 minutes'")"
echo "-- delete attempts (superuser): $(psql_control -At -c 'delete from migrations.bundle_revisions' 2>&1 | head -2 | tr '\n' ' ')"
echo "-- delete as exdb_serve:         $(PGPASSWORD=$(cred exdb_serve) psql -X -h 127.0.0.1 -p $EXSTACK_PORT_CONTROL -U exdb_serve -d exponetdb_control -At -c 'delete from migrations.bundle_revisions' 2>&1 | head -2 | tr '\n' ' ')"
echo "== step 3: fill until the filesystem is full $(now)"
n=0; first=""
while [ $n -lt 40 ]; do
  n=$((n+1)); bearer
  r=$($ING --per 8 --kb 3072 --requests 1 --tag s6b 2>&1 | tail -1)
  echo "fill $n: $(df -m --output=avail $D | tail -1 | tr -d ' ') MB free; $r" | cut -c1-260
  echo "$r" | grep -q '"200":1' || { first="$r"; break; }
done
echo "first failure: $first"
echo "container: $(docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}} restarts={{.RestartCount}}' $C)"
echo "-- postgres log:"; PGL 6m
t0
echo "== roles under a full disk (timeline)"
bearer
timeline 90 2 30 60
echo "-- serve log events:"; logs_since serve "-3 min" | jq -rc 'select(.level=="error" or .level=="warn")|[.msg,.causeCode,.errorCode,.errorName,.code]|@tsv' | sort | uniq -c | sort -rn | head
echo "-- worker log events:"; logs_since worker "-3 min" | jq -rc 'select(.level=="error" or .level=="warn")|[.msg,.causeCode,.code]|@tsv' | sort | uniq -c | sort -rn | head -5
echo "-- detail: $(hdetail $S | jq -c '[.status, (.checks[]|select(.status!="pass")|{name,status,reason})]')"
echo "-- what a full store allows: VACUUM (superuser): $(psql_control -At -c 'vacuum observation.findings' 2>&1 | head -1)"
echo "-- audit prune (login exdb_audit_maint): $(EXPONETDB_LOG_LEVEL=warn EXPONETDB_CONTROL_STORE_URL="$(store_url exdb_audit_maint)" node_run audit prune 2>&1 | head -3 | tr '\n' ' ')"
echo "== recovery: grow the image by 300 MB (truncate, losetup -c, resize2fs) $(now)"
truncate -s +300M $IMG; LD=$(losetup -j $IMG | cut -d: -f1); losetup -c $LD; resize2fs $LD >/dev/null 2>&1
echo "df: $(df -m --output=size,used,avail $D | tail -1)"
t0
for i in $(seq 1 90); do r=$(hc $S); printf 't=%s serve=%s worker=%s gw=%s\n' "$(el)" "$r" "$(hc $W)" "$(hc $G)"; [ "$r" = 200 ] && [ "$(hc $W)" = 200 ] && break; sleep 2; done | tail -3
bearer; mut
echo "container: $(docker inspect -f '{{.State.Status}}' $C)"; PGL 2m 4
echo "== revert to the saved data directory $(now)"
for r in serve worker gateway; do systemctl stop $(_stk_unit $r); done
docker stop $C >/dev/null; umount $D; rmdir $D 2>/dev/null; mv $D.orig $D; rm -f $IMG
docker start $C >/dev/null; _stk_wait_control; restart_cp
echo "reverted: serve=$(hc $S) $(cs_status 2>&1 | head -3 | tr '\n' ' ')"
