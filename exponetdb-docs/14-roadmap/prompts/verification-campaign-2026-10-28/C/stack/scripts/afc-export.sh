#!/usr/bin/env bash
# audit export down: (1) the file sink unwritable, (2) an S3 sink (versitygw container) stopped. Mutations must continue.
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/afc.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
EXPD=/srv/work/s6/audit-export
due() { ctl_sql "UPDATE control.maintenance_tasks SET next_run_at = now(), lease_owner=NULL, lease_expires_at=NULL WHERE task IN ('audit.checkpoint','audit.export')" >/dev/null; }
report() { # label
  echo "-- $1 ($(now))"
  echo "   tasks: $(ctl_sql "select string_agg(task||'='||coalesce(last_outcome,'-')||'/'||consecutive_failures||'/'||coalesce(last_reason,'-'), ' ') from control.maintenance_tasks where task like 'audit.%'")"
  echo "   worker ready=$(hc $W) detail=$(hdetail $W | jq -c '[.status,(.checks[]?|select(.status!="pass")|{name,status,reason})]')"
  echo "   serve ready=$(hc $S) (public $(curl -s -o /dev/null -w '%{http_code}' $API/healthz/ready))"
  echo "   metrics: $(curl -s http://$W/metrics | grep 'task="audit.export"' | tr '\n' ' ')"
  echo "   log: $(logs_since worker "-3 min" | jq -rc 'select(.msg|test("audit"))|[.level,.msg,.seq,.count,.code,.reason]|@tsv' | sort | uniq -c | head -4 | tr '\n' '|')"
  bearer; rest GET /api/v1/installation/health | head -1 >/dev/null
  echo "   installation/health audit_chain: $(jq -c '[.components[]?|select((.id // .name // .component)=="audit_chain")|{state,reasons}]' /dev/shm/s6out.last | head -c 300)"
  echo "   mutation: $(mut)"
}
echo "== baseline"; bearer; due; sleep 20; report baseline; ls $EXPD | head -3; echo "exported files: $(ls $EXPD | wc -l)"
echo "== (1) file sink unwritable: chmod 000 $EXPD $(now)"
chmod 000 $EXPD; M=$(mut); echo "new events to export: $M" >/dev/null; mut >/dev/null
for i in 1 2 3; do due; sleep 20; done; report "file sink down"
echo "-- recovery: chmod 755"; chmod 755 $EXPD; chown exstack: $EXPD; due; sleep 25; report "file sink back"; echo "exported files: $(ls $EXPD | wc -l)"
echo "== (2) S3 sink: versitygw container $(now)"
docker rm -f s6-s3 >/dev/null 2>&1
SEC=$(openssl rand -hex 16)
docker run -d --name s6-s3 -e ROOT_ACCESS_KEY=s6test -e ROOT_SECRET_KEY="$SEC" --tmpfs /data -p 127.0.0.1:57170:7070 versity/versitygw:v1.8.0 --port :7070 posix /data >/dev/null 2>&1 || docker run -d --name s6-s3 -e ROOT_ACCESS_KEY=s6test -e ROOT_SECRET_KEY="$SEC" --tmpfs /data -p 127.0.0.1:57170:7070 versity/versitygw --port :7070 posix /data >/dev/null
for i in $(seq 1 20); do curl -s -o /dev/null http://127.0.0.1:57170/ && break; sleep 1; done
docker exec s6-s3 mkdir -p /data/s6audit 2>&1 | head -1
cp /srv/work/s6/state/env/worker.env /srv/work/s6/state/env/worker.env.s6bak
sed -i '/^EXPONETDB_AUDIT_EXPORT_DIR=/d' /srv/work/s6/state/env/worker.env
{ echo "EXPONETDB_AUDIT_S3_ENDPOINT=http://127.0.0.1:57170"; echo "EXPONETDB_AUDIT_S3_REGION=us-east-1"; echo "EXPONETDB_AUDIT_S3_BUCKET=s6audit"; echo "EXPONETDB_AUDIT_S3_ACCESS_KEY_ID=s6test"; echo "EXPONETDB_AUDIT_S3_SECRET_ACCESS_KEY=$SEC"; } >>/srv/work/s6/state/env/worker.env
systemctl restart $(_stk_unit worker); for i in $(seq 1 40); do [ "$(hc $W)" = 200 ] && break; sleep 1; done
mut >/dev/null; due; sleep 25; report "S3 sink up"; echo "objects in bucket: $(docker exec s6-s3 sh -c 'find /data/s6audit -type f | wc -l')"
echo "-- stop the S3 gateway $(now)"; docker stop s6-s3 >/dev/null
mut >/dev/null; for i in 1 2 3; do due; sleep 20; done; report "S3 down"
echo "-- start the S3 gateway again"; docker start s6-s3 >/dev/null; sleep 3; due; sleep 25; report "S3 back"; echo "objects in bucket: $(docker exec s6-s3 sh -c 'find /data/s6audit -type f | wc -l')"
echo "== restore the worker environment"
mv /srv/work/s6/state/env/worker.env.s6bak /srv/work/s6/state/env/worker.env; chmod 600 /srv/work/s6/state/env/worker.env
systemctl restart $(_stk_unit worker); for i in $(seq 1 40); do [ "$(hc $W)" = 200 ] && break; sleep 1; done
docker rm -f s6-s3 >/dev/null; echo "worker ready=$(hc $W)"
