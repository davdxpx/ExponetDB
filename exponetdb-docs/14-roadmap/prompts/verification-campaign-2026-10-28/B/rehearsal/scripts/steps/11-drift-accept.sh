source /srv/work/s5/rehearsal/rh-lib.sh
cd $PROJ
FND=$(jq -r '.data.items[0].id' $L/findings-after-bundles.json)
human call POST /api/v1/findings/$FND/accept '{"reason":"The 34 findings are the effect of eight bundles applied and verified through ExponetDB; the baseline did not follow a plan that stopped part-way"}' > $L/drift-accept-plan.json
jq -c '{status, id: .body.id, decision: .body.decision, class: .body.class}' $L/drift-accept-plan.json
PL=$(jq -r '.body.id' $L/drift-accept-plan.json)
tm drift-accept-apply human apply $PL --approve
sleep 5
TAIL=6 tm drift-after-accept exdb drift check lab/platform/rhstg
