source /srv/work/s4/env.sh; cd $S4; refresh_creds
P=$(new_project s4promo5)
mkb $P s4-promo-f --nontransactional >/dev/null <<<"CREATE INDEX CONCURRENTLY s4_e_id_idx ON public.s4_e(id); GRANT SELECT ON public.s4_e TO lab_owner;"
mplan $P lab/platform/s4evi; mapply $PLAN_ID | cut -c1-140
IDF=$(ls $P/migrations | grep s4-promo-f | cut -d_ -f1); echo $IDF > promo.idf
PRD=$(stack_id target_s4prd)
for i in 1 2 3; do
curl -s -X POST -H "Authorization: Bearer $(cat creds/owner.token)" -H 'content-type: application/json' -d "{\"migrationIds\":[\"$IDF\"]}" http://127.0.0.1:58480/api/v1/targets/$PRD/migrations/plans > $L4/api/planF-$i.json
jq -c '{id,decision,req:[.requirements[]?|.kind],err:.code,rules:[.policyRules[]?|select(.result!="pass")|.id]}' $L4/api/planF-$i.json | cut -c1-300
jq -r '.id // empty' $L4/api/planF-$i.json > $S4/rb$i.plan
done
