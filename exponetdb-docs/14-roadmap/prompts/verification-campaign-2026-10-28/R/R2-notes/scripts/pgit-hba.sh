export PATH=$PATH:/usr/local/go/bin:/usr/local/bin
. /srv/work/r2/ftlib.sh
rm -rf /srv/work/r2/nodecl-pgit; mkdir -p /srv/work/r2/nodecl-pgit
EXDB_NODE_PG_VERSIONS=17 EXDB_NODE_AGENT_USER="root" bash /srv/work/r2/new/tooling/dev/node-clusters.sh /srv/work/r2/nodecl-pgit > /srv/work/r2/clusters-pgit.env 2>/srv/work/r2/logs/pgit-clusters.err
eval "$(cat /srv/work/r2/clusters-pgit.env)"
echo "EXDB_NODE_CLUSTERS=$EXDB_NODE_CLUSTERS"
echo "### 1. the shipped apply-time test on the new tree"
(cd /srv/work/r2/new/agent/node && go test -count=1 -tags pgit -run 'TestHbaKeepsExponetDBsOwnAccess' -v ./internal/capabilities 2>&1 | tail -8)
echo "### 2. mutation: the agent's apply-time check is disabled in a scratch copy"
rm -rf /srv/work/r2/mut2; cp -r /srv/work/r2/new/agent/node /srv/work/r2/mut2
python3 - <<'PY'
p='/srv/work/r2/mut2/internal/capabilities/hba.go'
s=open(p).read()
a="if _, err := matchAccess(lines, own); err != nil {"
b="\t\tline, err := matchAccess(lines, a)\n\t\tif err != nil {"
assert a in s and b in s
s=s.replace(a,"if _, err := matchAccess(lines, own); err != nil && false {")
s=s.replace(b,"\t\tline, err := matchAccess(lines, a)\n\t\tif err != nil && false {")
open(p,'w').write(s)
PY
(cd /srv/work/r2/mut2 && go test -count=1 -tags pgit -run 'TestHbaKeepsExponetDBsOwnAccess' -v ./internal/capabilities 2>&1 | grep -aE "^(---|===|ok|FAIL|\s+capabilities_pgit)|lockout|restored" | head -10)
echo "### 3. R2 test on the new tree (scratch copy): a rule the plan cannot judge (samehost reject) against a network access"
rm -rf /srv/work/r2/mut3; cp -r /srv/work/r2/new/agent/node /srv/work/r2/mut3
cat >> /srv/work/r2/mut3/internal/capabilities/capabilities_pgit_test.go <<'GO'

func TestR2HbaRuleThePlanCannotJudge(t *testing.T) {
	eachMajor(t, func(t *testing.T, h *harness) {
		cl := h.cluster()
		inspect := h.must("postgres.hba.inspect@2", obj("cluster", cl))
		original, _, _ := readFileAs(h, h.in.HbaFile)
		network := canon.Array{obj("role", "app_user", "database", "app", "address", "10.1.0.5", "method", "scram-sha-256")}
		unjudged := obj("cluster", cl, "managedRules", canon.Array{
			obj("type", "hostssl", "database", canon.Array{canon.String("all")}, "user", canon.Array{canon.String("all")},
				"address", "samehost", "method", "reject", "map", nil),
		}, "expectedFileDigest", text(inspect, "fileDigest"), "protectedAccess", network)
		_, err := h.run("postgres.hba.apply@2", h.job("postgres.hba.apply@2", unjudged))
		t.Logf("R2-HBA apply of 'hostssl all all samehost reject' with a protected network access: err=%v", err)
		if err == nil || !strings.Contains(err.Error(), "restored") {
			t.Fatalf("R2: the agent applied a block it cannot judge: %v", err)
		}
		if now, _, _ := readFileAs(h, h.in.HbaFile); !bytes.Equal(now, original) {
			t.Fatal("R2: pg_hba.conf was not restored")
		}
		h.sql(`SELECT 1`)
	})
}
GO
(cd /srv/work/r2/mut3 && go test -count=1 -tags pgit -run 'TestR2HbaRuleThePlanCannotJudge' -v ./internal/capabilities 2>&1 | grep -aE "R2|^(---|ok|FAIL)" | head -10)
rm -rf /srv/work/r2/mut2 /srv/work/r2/mut3
echo PGIT-DONE
