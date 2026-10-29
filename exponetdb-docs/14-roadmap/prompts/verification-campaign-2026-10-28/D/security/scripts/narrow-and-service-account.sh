source /srv/work/s4/env.sh; cd $S4
( umask 077; cp ${EXSTACK_STATE}/owner.json humans/oauth-narrow.json )
STG=$(stack_id target_staging)
timeout 90 bash -c "source /srv/work/s4/env.sh; cli_as oauth-narrow targets.read --targets $STG" 2>&1 | tail -2; tok oauth-narrow
# service account
SAID=$(s4ts s4/ident.ts sa "S4 service account" 2>&1 | tail -1 | tee /dev/stderr | jq -r .serviceAccount); echo $SAID > $S4/sa.id
ENV_STG=$(stack_id env_staging)
s4ts s4/ident.ts bind $SAID developer environment $ENV_STG 2>&1 | tail -1
s4ts s4/ident.ts apikey $SAID service-account nonprod,prod 2>&1 | tail -1
ls -la $S4/creds | awk '{print $1,$5,$NF}'
