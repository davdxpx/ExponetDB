source /srv/work/s4/env.sh; cd $S4; refresh_creds
declare -A ID=( [developer-nonprod]=idn_01M64N6CEYR8265NS32ZAEH2G1 [developer-prod]=idn_01M64N6CZAQRA45NMX6SBF69FY )
s4ts s4/ident.ts bind ${ID[developer-nonprod]} developer environment $(stack_id env_s4evi) 2>&1 | tail -1
s4ts s4/ident.ts bind ${ID[developer-prod]} developer environment $(stack_id env_s4prd) 2>&1 | tail -1
P=$(new_project s4promo2)
mkb $P s4-promo-a >/dev/null <<<"CREATE TABLE public.s4_promo_a(id int primary key); GRANT SELECT ON public.s4_promo_a TO lab_owner;"
mkb $P s4-promo-b >/dev/null <<<"CREATE TABLE public.s4_promo_b(id int primary key); GRANT SELECT ON public.s4_promo_b TO lab_owner;"
echo $P > promo.dir
mplan $P lab/platform/s4evi
PLAN_ID=$PLAN_ID; mapply $PLAN_ID | cut -c1-200
cd $P; IDA=$(ls migrations | grep s4-promo-a | cut -d_ -f1); IDB=$(ls migrations | grep s4-promo-b | cut -d_ -f1); echo "$IDA $IDB" > $S4/promo.ids
PRD=$(stack_id target_s4prd)
for X in A B; do eval id=\$ID$X
  curl -s -X POST -H "Authorization: Bearer $(cat $S4/creds/developer-prod.token)" -H 'content-type: application/json' -d "{\"migrationIds\":[\"$id\"]}" http://127.0.0.1:58480/api/v1/targets/$PRD/migrations/plans > $L4/api/promo2-plan$X.json
  jq -c '{id,state,decision,code,req:[.requirements[]?|.kind//.id], rules:[.policyRules[]?|select(.result=="fail")|.id]}' $L4/api/promo2-plan$X.json | cut -c1-400
  jq -r '.id // empty' $L4/api/promo2-plan$X.json > $S4/promo.plan$X
done
