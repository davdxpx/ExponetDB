source /srv/work/s5/rehearsal/rh-lib.sh
cd $PROJ
TAIL=14 tm plan-b7-after-reconcile exdb migration plan --target lab/platform/rhstg 01M64QV9RY834WB26XS7ZKJ3NQ
PL=$(grep -o "pln_[A-Z0-9]*" $L/plan-b7-after-reconcile.log | head -1)
TAIL=8 tm apply-b7-again exdb plan apply $PL --wait
exdb migration status --target lab/platform/rhstg 2>&1 | sed -n 3,7p
psql_target pg17 -d lab_rhstg -Atc "select migration_id, name from exponetdb.schema_migrations order by applied_seq desc limit 3"
ctl_sql "select count(*) from migrations.ledger_mirror_history" 2>&1 | head -2
