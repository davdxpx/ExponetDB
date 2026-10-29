source /srv/work/s4/env.sh
cd $S4
pkill -f "exponetdb login" 2>/dev/null
sc() { ( cd ${EXSTACK_KIT} && bun --conditions=@exponetdb/source s4/scopes-for.ts "$@" ); }
for spec in "admin:admin" "developer-nonprod:developer" "developer-prod:developer" "viewer:viewer"; do
  n=${spec%%:*}; r=${spec##*:}
  echo "== $n"; timeout 90 bash -c "source /srv/work/s4/env.sh; cli_as $n \"$(sc $r)\"" 2>&1 | tail -2; tok $n
done
echo "== owner"; ( umask 077; jq -r '.credentials | to_entries[0].value.accessToken' ${EXSTACK_STATE}/cli/credentials.json > $S4/creds/owner.token )
ls -la $S4/creds | awk '{print $1,$5,$NF}'
