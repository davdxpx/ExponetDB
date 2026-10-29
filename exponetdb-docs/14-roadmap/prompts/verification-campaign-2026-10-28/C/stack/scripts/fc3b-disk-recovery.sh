#!/usr/bin/env bash
# fail-closed step 3, recovery half: fill the small volume until PostgreSQL PANICs, grow the volume, start the container,
# measure time to PostgreSQL ready / roles ready, and check that nothing committed was lost.
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/fc3b.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
D=${EXSTACK_CONTROL_DATA}; C=$EXSTACK_CONTROL_NAME; IMG=/srv/work/s6/cs-small.img; MB=300
ING="node /srv/work/s6-infra/s6/ingest.mjs --api $API --headers $HDR --project $(jq -r .project ${EXSTACK_STATE}/ids.json)"
docker stop $C >/dev/null; mv $D $D.orig
dd if=/dev/zero of=$IMG bs=1M count=$MB status=none; mkfs.ext4 -q -m 0 $IMG; mkdir -p $D; mount -o loop $IMG $D; rsync -a $D.orig/ $D/
docker start $C >/dev/null; _stk_wait_control; for i in $(seq 1 60); do [ "$(hc $S)" = 200 ] && break; sleep 1; done
bearer; echo "ready on the small fs: $(df -m --output=avail $D | tail -1 | tr -d ' ') MB free; audit head $(audit_head)"
for n in $(seq 1 20); do bearer; r=$($ING --per 8 --kb 3072 --requests 1 --tag s6c 2>&1 | tail -1); echo "fill $n: $(df -m --output=avail $D | tail -1 | tr -d ' ') MB free; $(echo "$r" | jq -c '.statuses')"; echo "$r" | grep -q '"200":1' || break; done
TC=$(date +%s.%N); echo "crash at $(now); container: $(docker inspect -f '{{.State.Status}}' $C)"
for i in $(seq 1 20); do [ "$(docker inspect -f '{{.State.Status}}' $C)" != running ] && break; sleep 1; done
echo "container after $(printf '%.0f' $(echo "$(date +%s.%N)-$TC" | bc)) s: $(docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}}' $C)"
echo "-- start without more space (what a restart policy would do): $(docker start $C >/dev/null 2>&1; sleep 6; docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}}' $C)"
docker logs --since 30s $C 2>&1 | grep -E "FATAL|PANIC" | sed 's/^[0-9-]* [0-9:.]* UTC //' | uniq -c | head -4
echo "== recovery: grow by 300 MB, start $(now)"
docker stop $C >/dev/null 2>&1
truncate -s +300M $IMG; LD=$(losetup -j $IMG | cut -d: -f1); losetup -c $LD; resize2fs $LD >/dev/null 2>&1
TS=$(date +%s.%N); docker start $C >/dev/null; _stk_wait_control; echo "PostgreSQL accepts connections after $(printf '%.1f' $(echo "$(date +%s.%N)-$TS" | bc)) s"
for i in $(seq 1 90); do [ "$(hc $S)" = 200 ] && [ "$(hc $W)" = 200 ] && [ "$(hc $G)" = 200 ] && break; sleep 1; done; echo "roles ready after $(printf '%.1f' $(echo "$(date +%s.%N)-$TS" | bc)) s (no role restart): serve=$(hc $S) worker=$(hc $W) gw=$(hc $G)"
echo "audit head $(audit_head); verify: $(ro audit verify 2>&1 | grep -E 'verifiedEvents|ok|valid' | tr '\n' ' ')"
echo "revisions: $(ctl_sql 'select count(*) from migrations.bundle_revisions'); table: $(ctl_sql "select pg_size_pretty(pg_total_relation_size('migrations.bundle_revisions'))")"
bearer; echo "mutation: $(mut)"
echo "== revert $(now)"
for r in serve worker gateway; do systemctl stop $(_stk_unit $r); done
docker stop $C >/dev/null; umount $D; rmdir $D 2>/dev/null; mv $D.orig $D; rm -f $IMG
docker start $C >/dev/null; _stk_wait_control; restart_cp; echo "reverted: serve=$(hc $S)"
