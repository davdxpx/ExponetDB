cd /srv/work/s3-infra/s3 && . ./lib.sh && s3_release old
dir="$(new_project afterrestore)"
mkb "$dir" after-restore-change <<'SQL' >/dev/null
CREATE TABLE public.after_restore (id int PRIMARY KEY);
GRANT SELECT ON public.after_restore TO lab_owner;
SQL
for t in staging dev16 dev18; do
  cd "$dir"; j="$(exdb_json migration plan --target lab/platform/$t)"; rc=$?
  echo "OLD release, plan on $t: rc=$rc state=$(jq -r '.data.state // "-"' <<<"$j") decision=$(jq -r '.data.decision // "-"' <<<"$j") error=$(jq -r '.error.code // "-"' <<<"$j") msg=$(jq -r '.error.message // "-"' <<<"$j" | cut -c1-200)"
  jq -c '[.data.policyRules[]? | select(.result!="pass") | {id,message}]' <<<"$j" | cut -c1-500
done
echo "--- text output of the refusal (what the operator reads)"
cd "$dir"; exdb migration plan --target lab/platform/staging 2>&1 | head -14
echo "--- mirror vs ledger per target"
for t in staging dev16 dev18; do echo "$t: $(exdb_json migration status --target lab/platform/$t | jq -c '{ledger: (.data.ledger // null), mirror: (.data.mirror // null)}' | cut -c1-300)"; done
