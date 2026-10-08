package fsafe

import (
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type recorded struct {
	step Step
	name string
}

// record collects the steps of what fn writes.
func record(t *testing.T, fn func()) []recorded {
	t.Helper()
	var steps []recorded
	FaultHook = func(s Step, _, name string) error {
		steps = append(steps, recorded{s, name})
		return nil
	}
	defer func() { FaultHook = nil }()
	fn()
	return steps
}

func indexOf(steps []recorded, s Step, name string) int {
	for i, r := range steps {
		if r.step == s && r.name == name {
			return i
		}
	}
	return -1
}

func openTemp(t *testing.T) (*Dir, string) {
	t.Helper()
	root := t.TempDir()
	d, err := OpenDir(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	return d, root
}

// TestReplaceSyncsThePreviousCopyBeforeTheFile: the previous copy's rename is
// durable (a directory sync) before the file itself is renamed, so a crash
// can never leave the new content without the previous one kept.
func TestReplaceSyncsThePreviousCopyBeforeTheFile(t *testing.T) {
	d, _ := openTemp(t)
	o := Owner{UID: os.Geteuid(), GID: os.Getegid(), Mode: 0o600}
	if err := d.Replace("server.key", []byte("old"), o); err != nil {
		t.Fatal(err)
	}
	steps := record(t, func() {
		if err := d.Replace("server.key", []byte("new"), o); err != nil {
			t.Fatal(err)
		}
	})
	kept := indexOf(steps, AfterRename, "server.key"+PreviousSuffix)
	main := indexOf(steps, BeforeRename, "server.key")
	if kept < 0 || main < 0 || kept > main {
		t.Fatalf("steps %v", steps)
	}
	synced := false
	for _, s := range steps[kept:main] {
		synced = synced || s.step == AfterDirSync
	}
	if !synced {
		t.Fatalf("no directory sync between the previous copy's rename and the file's: %v", steps)
	}
}

// TestRestoreOfAFileThatDidNotExistRemovesIt: a file that did not exist
// before the change is restored by removing it.
func TestRestoreOfAFileThatDidNotExistRemovesIt(t *testing.T) {
	d, root := openTemp(t)
	o := Owner{UID: os.Geteuid(), GID: os.Getegid(), Mode: 0o600}
	if err := d.Replace("server.key", []byte("new"), o); err != nil {
		t.Fatal(err)
	}
	if err := d.Restore("server.key"); err != nil {
		t.Fatalf("restore of a file that did not exist: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(root, "server.key")); !os.IsNotExist(err) {
		t.Fatalf("the file is still there: %v", err)
	}
	// Again: nothing to restore, nothing left.
	if err := d.Restore("server.key"); err != nil {
		t.Fatal(err)
	}
}

// TestAPreviousCopyAlwaysDescribesTheFileBeforeTheChange: a stale copy from
// an older change is dropped when the file does not exist, so a restore
// never brings back content older than the change it undoes.
func TestAPreviousCopyAlwaysDescribesTheFileBeforeTheChange(t *testing.T) {
	d, root := openTemp(t)
	if err := os.WriteFile(filepath.Join(root, "server.crt"+PreviousSuffix), []byte("stale"), 0o644); err != nil {
		t.Fatal(err)
	}
	o := Owner{UID: os.Geteuid(), GID: os.Getegid(), Mode: 0o644}
	if err := d.Replace("server.crt", []byte("new"), o); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(root, "server.crt"+PreviousSuffix)); !os.IsNotExist(err) {
		t.Fatalf("a stale previous copy survived: %v", err)
	}
	if err := d.Restore("server.crt"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(root, "server.crt")); !os.IsNotExist(err) {
		t.Fatalf("the restore brought back stale content: %v", err)
	}
}

var errInjected = errors.New("injected fault")

// TestAFaultAtAnyStepLeavesOldOrNewContent: whatever step of a replacement
// fails, before or after it happened, the file holds its old or its new
// content (never a torn or missing one), the error is reported and no
// temporary file is left.
func TestAFaultAtAnyStepLeavesOldOrNewContent(t *testing.T) {
	o := Owner{UID: os.Geteuid(), GID: os.Getegid(), Mode: 0o640}
	probe, _ := openTemp(t)
	if err := probe.Replace("f", []byte("old"), o); err != nil {
		t.Fatal(err)
	}
	steps := record(t, func() { _ = probe.Replace("f", []byte("new"), o) })
	if len(steps) == 0 {
		t.Fatal("no steps")
	}
	for i := range steps {
		d, root := openTemp(t)
		if err := d.Replace("f", []byte("old"), o); err != nil {
			t.Fatal(err)
		}
		n := 0
		FaultHook = func(Step, string, string) error {
			n++
			if n-1 == i {
				return errInjected
			}
			return nil
		}
		err := d.Replace("f", []byte("new"), o)
		FaultHook = nil
		if !errors.Is(err, errInjected) {
			t.Fatalf("fault at %v: %v", steps[i], err)
		}
		data, rerr := os.ReadFile(filepath.Join(root, "f"))
		if rerr != nil || (string(data) != "old" && string(data) != "new") {
			t.Fatalf("fault at %v: content %q %v", steps[i], data, rerr)
		}
		entries, _ := os.ReadDir(root)
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), ".") {
				t.Fatalf("fault at %v: temporary file %s left", steps[i], e.Name())
			}
		}
	}
}

// TestFaultHookIsAssignedOnlyByTests: the seam stays nil in every build that
// is not a test binary, because no source file of the module but a test
// assigns it.
func TestFaultHookIsAssignedOnlyByTests(t *testing.T) {
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "go.mod")); err != nil {
		t.Fatalf("module root: %v", err)
	}
	fset := token.NewFileSet()
	checked := 0
	err = filepath.WalkDir(root, func(path string, e fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if e.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		f, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
		if err != nil {
			return err
		}
		checked++
		ast.Inspect(f, func(n ast.Node) bool {
			var lhs []ast.Expr
			switch s := n.(type) {
			case *ast.AssignStmt:
				lhs = s.Lhs
			case *ast.ValueSpec:
				if f.Name.Name == "fsafe" || f.Name.Name == "fsutil" {
					return true // the declarations themselves (fsafe.FaultHook, fsutil.FaultHook)
				}
				for _, name := range s.Names {
					lhs = append(lhs, name)
				}
			}
			for _, x := range lhs {
				name := ""
				switch v := x.(type) {
				case *ast.Ident:
					name = v.Name
				case *ast.SelectorExpr:
					name = v.Sel.Name
				}
				if name == "FaultHook" {
					t.Errorf("%s assigns FaultHook", fset.Position(x.Pos()))
				}
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if checked < 20 {
		t.Fatalf("only %d source files checked", checked)
	}
}
