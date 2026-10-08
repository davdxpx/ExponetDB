package fsafe

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"syscall"
	"testing"
)

// TestKeepPreviousAndInstall: the previous copy keeps content, owner and
// mode; Install keeps none; Current reads absence as a fact.
func TestKeepPreviousAndInstall(t *testing.T) {
	d, root := openTemp(t)
	path := filepath.Join(root, "server.crt")
	if err := os.WriteFile(path, []byte("old"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o640); err != nil {
		t.Fatal(err)
	}
	prev, err := d.Current("server.crt", 1<<20)
	if err != nil || !prev.Existed || string(prev.Content) != "old" || prev.Stat.Mode != 0o640 {
		t.Fatalf("current %+v %v", prev, err)
	}
	if err := d.KeepPrevious("server.crt", prev); err != nil {
		t.Fatal(err)
	}
	if err := d.Install("server.crt", []byte("new"), Owner{UID: os.Geteuid(), GID: os.Getegid(), Mode: 0o644}); err != nil {
		t.Fatal(err)
	}
	kept, st, err := d.ReadFile("server.crt"+PreviousSuffix, 1<<20)
	if err != nil || string(kept) != "old" || st.Mode != 0o640 || st.UID != os.Geteuid() {
		t.Fatalf("kept %q %+v %v", kept, st, err)
	}
	data, st, _ := d.ReadFile("server.crt", 1<<20)
	if string(data) != "new" || st.Mode != 0o644 {
		t.Fatalf("installed %q %+v", data, st)
	}
	// Install alone keeps nothing.
	if err := d.Install("other", []byte("x"), Owner{UID: os.Geteuid(), GID: os.Getegid(), Mode: 0o600}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(root, "other"+PreviousSuffix)); !os.IsNotExist(err) {
		t.Fatal("Install kept a previous copy")
	}
	// A file that did not exist: no copy, and a stale one goes.
	missing, err := d.Current("server.key", 1<<20)
	if err != nil || missing.Existed {
		t.Fatalf("missing %+v %v", missing, err)
	}
	_ = os.WriteFile(filepath.Join(root, "server.key"+PreviousSuffix), []byte("stale"), 0o600)
	if err := d.KeepPrevious("server.key", missing); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(root, "server.key"+PreviousSuffix)); !os.IsNotExist(err) {
		t.Fatal("a stale copy survived")
	}
	if err := d.KeepPrevious("server.key", missing); err != nil {
		t.Fatalf("nothing to drop: %v", err)
	}
}

// TestSyncFileRefusesWhatIsNotARegularFile: a symlink or a FIFO in place of
// a managed file is refused, never followed or blocked on.
func TestSyncFileRefusesWhatIsNotARegularFile(t *testing.T) {
	d, root := openTemp(t)
	if err := os.WriteFile(filepath.Join(root, "f"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := d.SyncFile("f"); err != nil {
		t.Fatal(err)
	}
	_ = os.Symlink(filepath.Join(root, "f"), filepath.Join(root, "link"))
	if err := d.SyncFile("link"); err == nil {
		t.Fatal("a symlink was synced")
	}
	if err := syscall.Mkfifo(filepath.Join(root, "fifo"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := d.SyncFile("fifo"); err == nil {
		t.Fatal("a FIFO was synced")
	}
	if err := d.SyncFile("missing"); !errors.Is(err, ErrNotExist) {
		t.Fatalf("missing: %v", err)
	}
}

// TestRemoveTemporariesRemovesOnlyThem: only the regular files named like a
// temporary file of that name go; a symlink or a directory of that name
// stays, and a link's target is never touched.
func TestRemoveTemporariesRemovesOnlyThem(t *testing.T) {
	d, root := openTemp(t)
	outside := filepath.Join(t.TempDir(), "outside")
	_ = os.WriteFile(outside, []byte("outside"), 0o600)
	for name, kind := range map[string]string{
		".server.key.exponetdb-0123456789abcdef":                    "file",
		".server.key.exponetdb-fedcba9876543210":                    "file",
		".server.key.exponetdb-0123456789ABCDEF":                    "file", // not ours: upper case
		".server.key.exponetdb-0123456789abcde":                     "file", // not ours: 15 digits
		".server.crt.exponetdb-0123456789abcdef":                    "file", // another name
		".server.key.exponetdb-previous.exponetdb-0123456789abcdef": "file", // the previous copy's
		"server.key":                             "file",
		"server.key" + PreviousSuffix:            "file",
		".server.key.exponetdb-1111111111111111": "dir",
		".server.key.exponetdb-2222222222222222": "link",
	} {
		p := filepath.Join(root, name)
		switch kind {
		case "file":
			_ = os.WriteFile(p, []byte("x"), 0o600)
		case "dir":
			_ = os.Mkdir(p, 0o700)
		case "link":
			_ = os.Symlink(outside, p)
		}
	}
	if err := d.RemoveTemporaries("server.key"); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(root)
	var left []string
	for _, e := range entries {
		left = append(left, e.Name())
	}
	sort.Strings(left)
	want := []string{
		".server.crt.exponetdb-0123456789abcdef",
		".server.key.exponetdb-0123456789ABCDEF",
		".server.key.exponetdb-0123456789abcde",
		".server.key.exponetdb-1111111111111111",
		".server.key.exponetdb-2222222222222222",
		".server.key.exponetdb-previous.exponetdb-0123456789abcdef",
		"server.key",
		"server.key" + PreviousSuffix,
	}
	if len(left) != len(want) {
		t.Fatalf("left %v", left)
	}
	for i := range want {
		if left[i] != want[i] {
			t.Fatalf("left %v", left)
		}
	}
	if data, _ := os.ReadFile(outside); string(data) != "outside" {
		t.Fatal("a link target changed")
	}
	if err := d.RemoveTemporaries("server.key" + PreviousSuffix); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(root, ".server.key.exponetdb-previous.exponetdb-0123456789abcdef")); !os.IsNotExist(err) {
		t.Fatal("the previous copy's temporary file survived")
	}
	if err := d.RemoveTemporaries("../x"); err == nil {
		t.Fatal("a path was accepted")
	}
}
