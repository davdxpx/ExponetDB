source /srv/work/s5/rehearsal/rh-lib.sh
cd $PROJ
BASE=baseline:rehearsal-2024
VERIFY_SQL="SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='hr_items' AND column_name='flag') AS ok;" \
mkb $PROJ add-hr-items-flag --depends-on $BASE > $L/c1.id <<'SQL'
ALTER TABLE public.hr_items ADD COLUMN IF NOT EXISTS flag boolean;
SQL
VERIFY_SQL="SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='sales_tags' AND column_name='flag') AS ok;" \
mkb $PROJ add-sales-tags-flag --depends-on $BASE > $L/c2.id <<'SQL'
ALTER TABLE public.sales_tags ADD COLUMN IF NOT EXISTS flag boolean;
SQL
C1=$(cat $L/c1.id); C2=$(cat $L/c2.id); echo C1=$C1 C2=$C2
for n in $C1 $C2; do d=$(ls -d migrations/${n}_*); sed -i 's/^  declared: additive/  declared: additive/' $d/migration.yaml; done
echo "=== C1 on staging (plan + apply)"
TAIL=3 tm c1-plan-staging exdb migration plan $C1 --target lab/platform/rhstg
PL=$(grep -o "pln_[A-Z0-9]*" $L/c1-plan-staging.log | head -1)
TAIL=6 tm c1-apply-staging exdb plan apply $PL --wait
echo "=== CHEAT A: C2 never applied on staging, planned for production"
TAIL=18 tm cheatA-plan exdb migration plan $C2 --target lab/platform/rhprod
echo "=== promote C1 correctly"
TAIL=24 tm c1-plan-prod exdb migration plan $C1 --target lab/platform/rhprod
grep -o "pln_[A-Z0-9]*" $L/c1-plan-prod.log | head -1 > $L/plan-id-c1-prod
