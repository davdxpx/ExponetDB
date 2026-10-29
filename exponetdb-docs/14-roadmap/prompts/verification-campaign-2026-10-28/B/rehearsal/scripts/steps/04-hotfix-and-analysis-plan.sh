source /srv/work/s5/rehearsal/rh-lib.sh
cd $PROJ
echo '{"role":"owner","searchPath":["public"],"ledgers":["supabase"]}' > $PROJ/hints.json
runuser -u postgres -- env PGOPTIONS='-c role=lab_owner' psql -X -q -p 55417 -d lab_rhstg -v ON_ERROR_STOP=1 -f $RH/legacy/hotfix.sql && echo hotfix applied
TAIL=40 tm import-analyze-plan exdb_json migration import analyze --target lab/platform/rhstg --scratch lab/platform/rhscr --hints $PROJ/hints.json
jq -c '{id:.data.id, state:.data.state, decision:.data.decision, class:.data.class}' $L/import-analyze-plan.log 2>/dev/null | head
