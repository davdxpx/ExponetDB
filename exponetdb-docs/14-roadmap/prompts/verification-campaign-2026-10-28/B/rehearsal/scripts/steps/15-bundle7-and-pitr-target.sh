source /srv/work/s5/rehearsal/rh-lib.sh
cd $PROJ
HEAD=$(cat $L/b6.id)
VERIFY_SQL="SELECT to_regclass('public.region_settings') IS NOT NULL AS ok;" \
mkb $PROJ create-region-settings --depends-on $HEAD > $L/b7.id <<'SQL'
-- the last bundle: the point-in-time restore goes back to just before it
CREATE TABLE public.region_settings (region text PRIMARY KEY, config jsonb NOT NULL DEFAULT '{}'::jsonb);
INSERT INTO public.region_settings (region) VALUES ('eu'), ('us');
GRANT SELECT ON public.region_settings TO authenticated;
SQL
echo B7=$(cat $L/b7.id)
TAIL=3 tm plan-b7 exdb migration plan --target lab/platform/rhstg
PL=$(grep -o "pln_[A-Z0-9]*" $L/plan-b7.log | head -1); echo $PL > $L/plan-id-b7
sleep 20
# the recovery target: the database's own clock and the last marker row committed before it
TT=$(runuser -u postgres -- psql -X -Atq -p 55417 -d lab_rhstg -c "select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')||'+00'")
echo "$TT" > $L/pitr-target
echo "T_target=$TT; last marker before it: $(awk -v t="${TT/ /T}" '{ts=substr($2,1,26); if (ts < substr(t,1,26)) last=$0} END{print last}' $L/marker.log)"
TAIL=8 tm apply-b7 exdb plan apply $PL --wait
echo "B7 applied; last marker $(tail -1 $L/marker.log)"
runuser -u postgres -- psql -X -Atq -p 55417 -d lab_rhstg -c "select count(*) filter (where kind='rh-marker') from public.events_log" > $L/marker-count-after-b7
