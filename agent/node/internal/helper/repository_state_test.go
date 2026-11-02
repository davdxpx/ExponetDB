package helper

import (
	"testing"

	"github.com/davdxpx/ExponetDB/agent/node/internal/canon"
)

// VC-061: a wrong cipher key and a deleted repository were refused as "catalog not readable"
// (failed) and as a foreign stanza (precondition_failed, system_identifier_mismatch). They are
// named: repository_unreadable and repository_missing.
func TestRepositoryStatesAreNamed(t *testing.T) {
	b := newBackupEnv(t)
	b.mode(ModeOwned)
	listArgs := canon.Object{{Name: "cluster", Value: cluster()}, {Name: "repository", Value: pgbrRepo()}}
	verifyArgs := canon.Object{{Name: "cluster", Value: cluster()}, {Name: "repository", Value: pgbrRepo()},
		{Name: "runId", Value: canon.String(runA)}, {Name: "label", Value: canon.Null{}}, {Name: "snapshot", Value: canon.Null{}}}
	prepare := restoreJobArgs(runA, 55402)[:5]

	// A wrong key: pgBackRest reads the encrypted catalog as text.
	b.info = `not json`
	b.mustRefuse(OpBackupList, b.job("backup.list", listArgs), "repository_unreadable")
	b.mustRefuse(OpBackupVerify, b.job("backup.verify", verifyArgs), "repository_unreadable")
	b.mustRefuse(OpBackupRun, b.job("backup.run", runArgs(runA, "full", pgbrRepo())), "repository_unreadable")

	// A deleted repository: the stanza path is missing.
	b.info = `[{"name":"main","status":{"code":1,"message":"missing stanza path"},"db":[],"backup":[],"archive":[]}]`
	b.mustRefuse(OpBackupVerify, b.job("backup.verify", verifyArgs), "repository_missing")
	b.mustRefuse(OpBackupRun, b.job("backup.run", runArgs(runA, "full", pgbrRepo())), "repository_missing")
	b.mustRefuse(OpRestoreExecute, b.job("restore.execute", restoreJobArgs(runA, 55402)), "repository_missing")
	r := b.mustCall(OpRestorePrepare, b.job("restore.prepare", prepare))
	if !hasString(list(r, "refusals"), "repository_missing") || hasString(list(r, "refusals"), "system_identifier_mismatch") {
		t.Fatalf("prepare: %v", r)
	}
	if err := b.h.Schema.ValidateResult("restore.prepare@1", r); err != nil {
		t.Fatal(err)
	}
	// The list states it: a stanza that is missing, never an empty success.
	r = b.mustCall(OpBackupList, b.job("backup.list", listArgs))
	sv, _ := r.Get("stanza")
	st, _ := sv.(canon.Object)
	if status, _ := st.Get("status"); status != canon.String("missing") {
		t.Fatalf("list: %v", r)
	}
	// An engine error in the stanza (status 99) is unreadable, not another cluster.
	b.info = `[{"name":"main","status":{"code":99,"message":"other"},"db":[],"backup":[],"archive":[]}]`
	b.mustRefuse(OpBackupVerify, b.job("backup.verify", verifyArgs), "repository_unreadable")
	if len(b.run.find(SystemdRun, "--unit=")) != 0 {
		t.Fatal("a run started")
	}
}
