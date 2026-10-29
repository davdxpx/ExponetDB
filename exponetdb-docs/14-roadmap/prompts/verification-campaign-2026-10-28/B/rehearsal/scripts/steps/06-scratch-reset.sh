source /srv/work/s5/rehearsal/rh-lib.sh
cd $PROJ
scratch_reset() {
  exdb_json migration import scratch-reset-sql --scratch lab/platform/rhscr | jq -r '.data.sql // .data.script // .data' > $L/scratch-reset.sql
  wc -c $L/scratch-reset.sql
  psql_target pg17 -d lab_rhscr -X -q -v ON_ERROR_STOP=1 -f $L/scratch-reset.sql
}
tm scratch-reset scratch_reset
exdb migration import scratch-check --target lab/platform/rhstg --scratch lab/platform/rhscr 2>&1 | sed -n 4,16p
