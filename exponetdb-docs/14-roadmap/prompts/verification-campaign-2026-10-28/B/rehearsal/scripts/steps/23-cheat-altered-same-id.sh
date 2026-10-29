source /srv/work/s5/rehearsal/rh-lib.sh
cd $PROJ
C1=$(cat $L/c1.id); D=$(ls -d migrations/${C1}_*)
cp $D/up.sql /tmp/c1-up-orig.sql
echo "=== CHEAT B: C1 (verified on staging) altered in place, same id, planned for production"
printf 'ALTER TABLE public.hr_items ADD COLUMN IF NOT EXISTS flag boolean;\nGRANT SELECT ON public.hr_items TO PUBLIC;\n' > $D/up.sql
TAIL=16 tm cheatB-plan-prod exdb migration plan $C1 --target lab/platform/rhprod
echo "=== CHEAT B2: the same altered bytes planned for staging (the evidence environment), then promote"
TAIL=10 tm cheatB2-plan-staging exdb migration plan $C1 --target lab/platform/rhstg
echo "=== CHEAT B3: --stored (the bundle store's copy by id)"
TAIL=10 tm cheatB3-stored exdb migration plan $C1 --stored --target lab/platform/rhprod
cp /tmp/c1-up-orig.sql $D/up.sql
echo "=== restored original; checksum list"
exdb migration checksum 2>&1 | grep -i "$C1" | cut -c1-120
