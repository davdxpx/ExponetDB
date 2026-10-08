package fsutil

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestWriteAtomicReplacesAndLeavesNoTemporaryFiles(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	for _, content := range []string{"first", "second"} {
		if err := WriteAtomic(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		got, err := ReadLimited(path, 64)
		if err != nil || string(got) != content {
			t.Fatalf("read %q, %v", got, err)
		}
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v, %v", info.Mode(), err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("left %d entries", len(entries))
	}
}

func TestReadLimitedRefusesLinksLargeFilesAndDirectories(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	if err := os.WriteFile(target, []byte("0123456789"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadLimited(link, 64); err == nil {
		t.Error("followed a symbolic link")
	}
	if _, err := ReadLimited(target, 9); !errors.Is(err, ErrTooLarge) {
		t.Errorf("large file: %v", err)
	}
	if _, err := ReadLimited(dir, 64); err == nil {
		t.Error("read a directory")
	}
}

func TestCheckOwnedPrivate(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "f")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	me := Owner{UID: os.Getuid()}
	if err := CheckOwnedPrivate(path, me); err != nil {
		t.Fatal(err)
	}
	if err := CheckOwnedPrivate(path, Owner{UID: os.Getuid() + 1}); err == nil {
		t.Error("accepted another owner")
	}
	for _, mode := range []os.FileMode{0o620, 0o602, 0o604} {
		if err := os.Chmod(path, mode); err != nil {
			t.Fatal(err)
		}
		if err := CheckOwnedPrivate(path, me); err == nil {
			t.Errorf("accepted mode %04o", mode)
		}
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := CheckOwnedPrivate(path, Owner{UID: os.Getuid(), OtherReadable: true}); err != nil {
		t.Errorf("world-readable allowed: %v", err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if err := CheckOwnedPrivate(link, Owner{UID: os.Getuid(), OtherReadable: true}); err == nil {
		t.Error("accepted a symbolic link")
	}
}
