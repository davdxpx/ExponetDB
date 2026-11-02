package helper

import (
	"os"
	"strings"
	"testing"
)

// VC-060: prepare answered space_insufficient but an execute was accepted anyway and filled the
// disk; and prepare measured the engine directory, not the filesystem of the scratch directory.
func TestRestoreSpaceIsCheckedAtExecuteOnTheScratchFilesystem(t *testing.T) {
	b := newBackupEnv(t)
	scratch := b.root + "/var/lib/exponetdb-node-engine/scratch"
	if err := os.MkdirAll(scratch, 0o711); err != nil {
		t.Fatal(err)
	}
	var measured []string
	free := int64(1000) // far below the 23 MB backup of the fixture
	saved := freeSpace
	freeSpace = func(path string) (int64, error) {
		measured = append(measured, path)
		return free, nil
	}
	t.Cleanup(func() { freeSpace = saved })

	args := restoreJobArgs(runA, 55402)
	r := b.mustCall(OpRestorePrepare, b.job("restore.prepare", restoreJobArgs(runA, 55402)[:5]))
	if !hasString(list(r, "refusals"), "space_insufficient") {
		t.Fatalf("prepare: %v", r)
	}
	if len(measured) == 0 || !strings.HasSuffix(measured[len(measured)-1], "/scratch") {
		t.Fatalf("prepare measured %v, not the scratch directory", measured)
	}
	// execute repeats the check before anything is written.
	b.mustRefuse(OpRestoreExecute, b.job("restore.execute", args), CodePreconditionFailed)
	if _, err := os.Lstat(scratch + "/" + runA); !os.IsNotExist(err) {
		t.Fatal("a refused execute created the scratch directory")
	}
	if len(b.run.find(SystemdRun, "--unit=")) != 0 {
		t.Fatal("a refused execute started a run")
	}
	// With room, the same execute starts.
	free = 1 << 40
	b.mustCall(OpRestoreExecute, b.job("restore.execute", args))
}
