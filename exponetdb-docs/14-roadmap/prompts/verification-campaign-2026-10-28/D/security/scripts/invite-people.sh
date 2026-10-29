AT=@; LAB_DOMAIN=${LAB_DOMAIN:-lab.invalid}  # an address that cannot exist; built from parts so that no address is committed
source /srv/work/s4/env.sh
set -u
cd $S4
ENV_STG=$(stack_id env_staging); ENV_PRD=$(stack_id env_production)
declare -A IDS
for n in admin developer-nonprod developer-prod; do
  out=$(s4ts s4/ident.ts invite $n "s4-${n}${AT}${LAB_DOMAIN}" 2>&1 | tail -1); echo "$out"
  IDS[$n]=$(jq -r .identityId <<<"$out")
done
out=$(s4ts s4/ident.ts invite viewer "s4-viewer2${AT}${LAB_DOMAIN}" 2>&1 | tail -1); echo "$out"
