source /srv/work/s4/env.sh
cd $S4
for n in admin developer-nonprod developer-prod viewer; do
  EXSTACK_OWNER_FILE=$S4/humans/$n.json s4ts human.ts enroll < humans/$n.link 2>&1 | tail -1
done
ls -la humans | awk '{print $1,$NF}'
declare -A ID=( [admin]=idn_01M64N6BYR7Z08NVZT7B5MXC2B [developer-nonprod]=idn_01M64N6CEYR8265NS32ZAEH2G1 [developer-prod]=idn_01M64N6CZAQRA45NMX6SBF69FY [viewer]=idn_01M64N6DHPP5GJ756R3DRSR3YA )
ENV_STG=$(stack_id env_staging); ENV_PRD=$(stack_id env_production)
s4ts s4/ident.ts bind ${ID[admin]} admin global 2>&1 | tail -1
s4ts s4/ident.ts bind ${ID[developer-nonprod]} developer environment $ENV_STG 2>&1 | tail -1
s4ts s4/ident.ts bind ${ID[developer-prod]} developer environment $ENV_PRD 2>&1 | tail -1
s4ts s4/ident.ts bind ${ID[viewer]} viewer global 2>&1 | tail -1
