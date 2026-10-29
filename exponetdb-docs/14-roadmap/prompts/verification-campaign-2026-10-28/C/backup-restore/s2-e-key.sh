# Phase E3: wrong cipher passphrase and deleted repository, helper level: what each capability answers (no waiting on runs that never start)
source /srv/work/s2/scripts/s2-lib.sh
exec > >(tee -a $LOGS/e3-key.log) 2>&1
mode owned; bind
T='{"label":null,"time":null,"lsn":null,"timeline":null}'
probe() { # label
  local R=$(rid)
  echo "  backup.list      : $(c backup.list "{\"cluster\":$CLUSTER,\"repository\":$REPOJ}" | jq -c '.error // {backups:(.result.backups|length)}')"
  local v=$(c backup.verify "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"label\":null,\"snapshot\":null}"); echo "  backup.verify    : start $(echo "$v"|jq -c '.error // {started:.result.runId}')"
  if echo "$v" | jq -e '.result.runId' >/dev/null 2>&1; then local o=$(wait_run $R 300); echo "    -> $(echo "$o"|jq -c '.result|{state,exitCode,verifyErrors:.outcome.verifyErrors}') :: $(echo "$o"|jq -r .result.excerpt|grep -E "ERROR|error|ERR|raised|FormatError|unable|crypto|Crypto|not found" | head -2 | cut -c1-240)"; fi
  R=$(rid); local b=$(c backup.run "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"kind\":\"incremental\",\"databases\":[]}"); echo "  backup.run incr  : start $(echo "$b"|jq -c '.error // {started:.result.runId}')"
  if echo "$b" | jq -e '.result.runId' >/dev/null 2>&1; then local o=$(wait_run $R 300); echo "    -> $(echo "$o"|jq -c '.result|{state,exitCode}') :: $(echo "$o"|jq -r .result.excerpt|grep -E "ERROR|error|raised|unable|Crypto|not found|stanza" | head -2 | cut -c1-240)"; fi
  R=$(rid); echo "  restore.prepare  : $(c restore.prepare "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"purpose\":\"drill\",\"target\":$T}" | jq -c '.error // .result')"
  c restore.discard "{\"runId\":\"$R\"}" >/dev/null 2>&1
  echo "  pgbackrest info  : $(runuser -u postgres -- pgbackrest --stanza=exdbnode info 2>&1 | head -4 | tr '\n' '|' | cut -c1-300)"
  echo "  pgbackrest check : $(runuser -u postgres -- pgbackrest --stanza=exdbnode check 2>&1 | tail -3 | tr '\n' '|' | cut -c1-300)"
  echo "  archiver         : $(DB=postgres psqlx "SELECT 'failed_count='||failed_count||' last_failed_wal='||coalesce(last_failed_wal,'-')" FROM pg_stat_archiver | head -1)"
}
echo "=========== wrong cipher passphrase in the host configuration"
bash /srv/work/s2/scripts/s2-inject.sh wrong-key apply | head -1
probe wrong-key
sleep 20; echo "  after 20 s: pg_wal ready backlog $(ls /var/lib/postgresql/17/exdbnode/pg_wal/archive_status | grep -c ready); archiver $(DB=postgres psqlx "SELECT 'failed_count='||failed_count FROM pg_stat_archiver")"
bash /srv/work/s2/scripts/s2-inject.sh wrong-key revert | head -1
echo "  repaired: check $(runuser -u postgres -- pgbackrest --stanza=exdbnode check 2>&1 | tail -1)"
echo "=========== repository deleted (archive and backup directories moved away)"
bash /srv/work/s2/scripts/s2-inject.sh repo-deleted apply | head -1
probe repo-deleted
sleep 20; echo "  after 20 s: pg_wal ready backlog $(ls /var/lib/postgresql/17/exdbnode/pg_wal/archive_status | grep -c ready); archiver $(DB=postgres psqlx "SELECT 'failed_count='||failed_count||' last_failed_wal='||coalesce(last_failed_wal,'-') FROM pg_stat_archiver")"
bash /srv/work/s2/scripts/s2-inject.sh repo-deleted revert | head -1
sleep 10
echo "  repaired: check $(runuser -u postgres -- pgbackrest --stanza=exdbnode check 2>&1 | tail -1); backlog now $(ls /var/lib/postgresql/17/exdbnode/pg_wal/archive_status | grep -c ready)"
echo E3-DONE
