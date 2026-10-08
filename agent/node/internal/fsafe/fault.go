package fsafe

// Step names a point of a write: before and after every file sync, rename,
// unlink and directory sync. The fault and crash tests stop a write there.
type Step string

// The steps.
const (
	BeforeFileSync Step = "before-file-sync"
	AfterFileSync  Step = "after-file-sync"
	BeforeRename   Step = "before-rename"
	AfterRename    Step = "after-rename"
	BeforeUnlink   Step = "before-unlink"
	AfterUnlink    Step = "after-unlink"
	BeforeDirSync  Step = "before-dir-sync"
	AfterDirSync   Step = "after-dir-sync"
)

// FaultHook is the test seam of the fault and crash tests. When set, it is
// called at every step with the directory's path and the name of the file the
// step is about (the target's name, never a temporary name); an error it
// returns is that step's failure, so an "after" step fails although the step
// itself happened (a rename that is done when the directory sync fails).
//
// It is nil in every build that is not a test binary: no source file of the
// module but a _test.go file assigns it, which
// TestFaultHookIsAssignedOnlyByTests checks.
var FaultHook func(step Step, dir, name string) error

func (d *Dir) fault(step Step, name string) error {
	if FaultHook == nil {
		return nil
	}
	return FaultHook(step, d.path, name)
}
