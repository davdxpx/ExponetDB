package fsafe

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestOpenDirRefusesSymlinksAnywhere(t *testing.T) {
	root := t.TempDir()
	real := filepath.Join(root, "real", "conf")
	if err := os.MkdirAll(real, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "real"), filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	if d, err := OpenDir(real); err != nil {
		t.Fatal(err)
	} else {
		_ = d.Close()
	}
	if _, err := OpenDir(filepath.Join(root, "link", "conf")); err == nil {
		t.Fatal("a symlinked directory component was followed")
	}
	for _, bad := range []string{"relative/path", root + "/../x", root + "/./real", ""} {
		if _, err := OpenDir(bad); err == nil {
			t.Fatalf("%q accepted", bad)
		}
	}
}

func TestReplaceKeepsThePreviousContentAndNeverFollowsALink(t *testing.T) {
	root := t.TempDir()
	d, err := OpenDir(root)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	o := Owner{UID: os.Getuid(), GID: os.Getgid(), Mode: 0o640}
	if err := d.Replace("pg_hba.conf", []byte("first\n"), o); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "pg_hba.conf"+PreviousSuffix)); !os.IsNotExist(err) {
		t.Fatal("a previous copy of nothing")
	}
	if err := d.Replace("pg_hba.conf", []byte("second\n"), o); err != nil {
		t.Fatal(err)
	}
	data, st, err := d.ReadFile("pg_hba.conf", 1<<20)
	if err != nil || string(data) != "second\n" || st.Mode != 0o640 {
		t.Fatalf("%q %v %v", data, st, err)
	}
	prev, _, _ := d.ReadFile("pg_hba.conf"+PreviousSuffix, 1<<20)
	if string(prev) != "first\n" {
		t.Fatalf("previous %q", prev)
	}
	if err := d.Restore("pg_hba.conf"); err != nil {
		t.Fatal(err)
	}
	if data, _, _ := d.ReadFile("pg_hba.conf", 1<<20); string(data) != "first\n" {
		t.Fatalf("restored %q", data)
	}
	// A symlink in place of the target is refused, read or written.
	outside := filepath.Join(t.TempDir(), "outside")
	_ = os.WriteFile(outside, []byte("outside\n"), 0o600)
	_ = os.Symlink(outside, filepath.Join(root, "evil.conf"))
	if _, _, err := d.ReadFile("evil.conf", 1<<20); err == nil {
		t.Fatal("read through a symlink")
	}
	if err := d.Replace("evil.conf", []byte("x"), o); err == nil {
		t.Fatal("replaced through a symlink")
	}
	if data, _ := os.ReadFile(outside); string(data) != "outside\n" {
		t.Fatal("the symlink's target changed")
	}
	// Names with a slash or dots are refused; no temporary file is left.
	for _, bad := range []string{"../x", "a/b", ".", ""} {
		if err := d.Replace(bad, []byte("x"), o); err == nil {
			t.Fatalf("%q accepted", bad)
		}
	}
	entries, _ := os.ReadDir(root)
	for _, e := range entries {
		if strings.Contains(e.Name(), ".exponetdb-") && !strings.HasSuffix(e.Name(), PreviousSuffix) {
			t.Fatalf("temporary file left: %s", e.Name())
		}
	}
	if _, _, err := d.ReadFile("missing", 1); !errors.Is(err, ErrNotExist) {
		t.Fatalf("missing: %v", err)
	}
	if _, _, err := d.ReadFile("pg_hba.conf", 2); err == nil {
		t.Fatal("size limit ignored")
	}
}

func TestSplit(t *testing.T) {
	dir, name, err := Split("/etc/postgresql/17/main/pg_hba.conf")
	if err != nil || dir != "/etc/postgresql/17/main" || name != "pg_hba.conf" {
		t.Fatalf("%s %s %v", dir, name, err)
	}
	for _, bad := range []string{"/", "rel/x", "/a/../b", "/a/"} {
		if _, _, err := Split(bad); err == nil {
			t.Fatalf("%q accepted", bad)
		}
	}
}

func TestCreateRemoveAndFiles(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	d, err := OpenDir(root)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	o := Owner{UID: os.Geteuid(), GID: os.Getegid(), Mode: 0o600}
	if err := d.Create("a.key", []byte("one"), o); err != nil {
		t.Fatal(err)
	}
	if err := d.Create("a.key", []byte("two"), o); err == nil {
		t.Fatal("Create replaced an existing file")
	}
	if data, _ := os.ReadFile(filepath.Join(root, "a.key")); string(data) != "one" {
		t.Fatalf("content %q", data)
	}
	_ = os.Symlink("/etc/passwd", filepath.Join(root, "link"))
	_ = os.Mkdir(filepath.Join(root, "sub"), 0o700)
	files, err := d.Files()
	if err != nil || len(files) != 1 || files[0].Name != "a.key" {
		t.Fatalf("files %v %v", files, err)
	}
	if err := d.Remove("a.key"); err != nil {
		t.Fatal(err)
	}
	if err := d.Remove("a.key"); !errors.Is(err, ErrNotExist) {
		t.Fatalf("second remove %v", err)
	}
	if err := d.Remove("../x"); err == nil {
		t.Fatal("a path was removed")
	}
	if entries, _ := os.ReadDir(root); len(entries) != 2 {
		t.Fatalf("temporary files left: %v", entries)
	}
	owner, err := d.Owner()
	if err != nil || owner.UID != os.Geteuid() || owner.Mode.Perm() != 0o700 {
		t.Fatalf("owner %+v %v", owner, err)
	}
}

// TestAnOpenDirectoryIsNotResolvedAgain: once open, a directory swapped for
// a symlink between the check and the write does not redirect the write.
func TestAnOpenDirectoryIsNotResolvedAgain(t *testing.T) {
	root := t.TempDir()
	conf := filepath.Join(root, "conf")
	target := filepath.Join(root, "target")
	for _, d := range []string{conf, target} {
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	d, err := OpenDir(conf)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	// The swap: the checked directory moves away and a symlink takes its name.
	moved := filepath.Join(root, "moved")
	if err := os.Rename(conf, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, conf); err != nil {
		t.Fatal(err)
	}
	o := Owner{UID: os.Geteuid(), GID: os.Getegid(), Mode: 0o600}
	if err := d.Replace("pg_hba.conf", []byte("rules\n"), o); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(target, "pg_hba.conf")); err == nil {
		t.Fatal("the write followed the swapped-in symlink")
	}
	if data, err := os.ReadFile(filepath.Join(moved, "pg_hba.conf")); err != nil || string(data) != "rules\n" {
		t.Fatalf("the write did not reach the opened directory: %q %v", data, err)
	}
	// A fresh open of the swapped path is refused.
	if _, err := OpenDir(conf); err == nil {
		t.Fatal("the symlinked path opened")
	}
}

// TestAFIFOIsRefusedWithoutBlocking: a FIFO in a managed file's place never
// holds the helper, and special bits are never copied (Phase 4 review).
func TestAFIFOIsRefusedWithoutBlocking(t *testing.T) {
	root := t.TempDir()
	if err := syscall.Mkfifo(filepath.Join(root, "pg_hba.conf"), 0o600); err != nil {
		t.Fatal(err)
	}
	d, err := OpenDir(root)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	done := make(chan error, 1)
	go func() {
		_, _, err := d.ReadFile("pg_hba.conf", 1024)
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("a FIFO was read")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("reading a FIFO blocked")
	}
	if err := d.Replace("pg_hba.conf", []byte("x"), Owner{UID: os.Geteuid(), GID: os.Getegid(), Mode: 0o600}); err == nil {
		t.Fatal("a FIFO was replaced")
	}
	// Special bits.
	if err := os.WriteFile(filepath.Join(root, "f"), []byte("a"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(root, "f"), 0o4755); err != nil {
		t.Fatal(err)
	}
	_, st, err := d.ReadFile("f", 10)
	if err != nil || st.Mode != 0o755 {
		t.Fatalf("mode %v %v", st.Mode, err)
	}
	if err := d.Replace("f", []byte("b"), Owner{UID: os.Geteuid(), GID: os.Getegid(), Mode: 0o4755}); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"f", "f" + PreviousSuffix} {
		info, _ := os.Stat(filepath.Join(root, n))
		if info.Mode()&(os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != 0 {
			t.Fatalf("%s kept a special bit: %v", n, info.Mode())
		}
	}
}
